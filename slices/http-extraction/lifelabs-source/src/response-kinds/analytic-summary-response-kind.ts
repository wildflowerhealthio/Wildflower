import { Effect, Schema } from 'effect'
import { Observation, Patient } from 'fhir-r4/resources'
import type { FhirResource } from 'fhir-r4/resources'
import { HttpResponseKind, extractJson, recognizePortal } from 'http-extraction-fundamentals'

import { LIFELABS_TEST_SYSTEM, LifeLabsIdentifierSystem } from '../lifelabs.ts'
import { LIFELABS_SYSTEM } from '../source-system.ts'

/**
 * One row of `entity.analytics[]` from the MyCareCompass `GetAnalyticSummary`
 * payload. This is a bespoke (non-FHIR) shape, so every field is optional and
 * lenient — a capture that omits one simply leaves the corresponding Observation
 * slot empty rather than failing the decode. `testResultValue` and the reference
 * range arrive as strings; the collection instant arrives as a .NET
 * `/Date(ms±hhmm)/` token.
 */
const Analytic = Schema.Struct({
  testCode: Schema.optional(Schema.NullOr(Schema.String)),
  testItemId: Schema.optional(Schema.NullOr(Schema.String)),
  testItemName: Schema.optional(Schema.NullOr(Schema.String)),
  testName: Schema.optional(Schema.NullOr(Schema.String)),
  testResultValue: Schema.optional(Schema.NullOr(Schema.String)),
  referenceRange: Schema.optional(Schema.NullOr(Schema.String)),
  collectionDate: Schema.optional(Schema.NullOr(Schema.String)),
  collectionPostedDate: Schema.optional(Schema.NullOr(Schema.String)),
  abnormal: Schema.optional(Schema.NullOr(Schema.Boolean)),
  abnormalFlag: Schema.optional(Schema.NullOr(Schema.String)),
})

type Analytic = typeof Analytic.Type

/** One row of `entity.patients[]` — the account's patient identities. */
const PatientRow = Schema.Struct({
  text: Schema.optional(Schema.NullOr(Schema.String)),
  value: Schema.optional(Schema.NullOr(Schema.Union(Schema.String, Schema.Number))),
  isPrimary: Schema.optional(Schema.NullOr(Schema.Boolean)),
})

type PatientRow = typeof PatientRow.Type

/**
 * Just-enough schema for the `GetAnalyticSummary` response envelope. Only the
 * three fields the kind reads (`analytics`, `selectedPatient`, `patients`) are
 * modeled; the rest of the payload (`testItems`, `visitDateRange`, the status
 * envelope) is dropped on decode. `selectedPatient` is the id every synthesized
 * Observation's `subject` references and the synthesized `Patient.id`.
 */
const AnalyticSummaryPayload = Schema.Struct({
  entity: Schema.Struct({
    analytics: Schema.optionalWith(Schema.Array(Analytic), {
      default: (): readonly Analytic[] => [],
    }),
    selectedPatient: Schema.optional(Schema.NullOr(Schema.Union(Schema.String, Schema.Number))),
    patients: Schema.optionalWith(Schema.Array(PatientRow), {
      default: (): readonly PatientRow[] => [],
    }),
  }),
})

const decodeSummary = Schema.decode(Schema.parseJson(AnalyticSummaryPayload))
const decodePatient = Schema.decodeUnknown(Patient.Schema)
const decodeObservation = Schema.decodeUnknown(Observation.Schema)

/**
 * FHIR logical ids allow only `[A-Za-z0-9-.]{1,64}`, but `testItemId` is
 * base64 (carrying `+`, `/`, `=`). Map to a safe token: `+`→`-`, `/`→`.` (both
 * in the FHIR alphabet), strip `=` padding (deterministic from length, so no
 * collision), and replace anything else with `-`.
 */
const toFhirIdToken = (raw: string): string =>
  raw
    .replace(/\+/g, '-')
    .replace(/\//g, '.')
    .replace(/=+$/g, '')
    .replace(/[^A-Za-z0-9.-]/g, '-')

/**
 * Absolute epoch millis from a .NET `/Date(1779297900000-0400)/` token, or
 * `undefined` if unparseable. The trailing `±hhmm` is a display-only original
 * offset; the millis are already absolute UTC.
 */
const dotNetMillis = (raw: string | null | undefined): number | undefined => {
  if (raw == null) return undefined
  const m = /\/Date\((\d+)(?:[+-]\d{4})?\)\//.exec(raw)
  if (m === null) return undefined
  const millis = Number(m[1])
  return Number.isFinite(millis) ? millis : undefined
}

/**
 * `4.0 - 11.0` / `120- 160` / `0.350 - 0.450` → numeric `{ low, high }`; a range
 * that isn't a simple numeric interval yields `{}` (the raw string is still kept
 * as `referenceRange[].text`).
 */
const parseReferenceRange = (raw: string): { low?: number; high?: number } => {
  const m = /^\s*([\d.]+)\s*-\s*([\d.]+)\s*$/.exec(raw)
  if (m === null) return {}
  const low = Number(m[1])
  const high = Number(m[2])
  const out: { low?: number; high?: number } = {}
  if (Number.isFinite(low)) out.low = low
  if (Number.isFinite(high)) out.high = high
  return out
}

/**
 * A stable, FHIR-safe logical id for one analytic: the sanitized `testItemId`
 * (unique per analyte) — or `testCode` as a fallback — suffixed with the
 * collection instant so repeat draws of the same analyte across dates don't
 * collide. `undefined` when there is no code at all to key on (the caller
 * drops-and-counts those).
 */
const observationId = (a: Analytic): string | undefined => {
  const base = a.testItemId ?? a.testCode
  if (base == null || base.length === 0) return undefined
  const token = toFhirIdToken(base)
  const millis = dotNetMillis(a.collectionDate)
  const id = millis != null ? `${token}-${millis}` : token
  return id.slice(0, 64)
}

/**
 * The R4 `Patient` **wire** for the selected patient: `id` is the portal's
 * patient id (the id every Observation's `subject` references), carried again
 * as `identifier[0]`, and the display name (when present) lands as a single
 * `name[].text` entry — the source gives one combined string, not structured
 * family/given.
 */
const patientWire = (id: string, name: string | null | undefined): Record<string, unknown> => {
  const wire: Record<string, unknown> = {
    resourceType: 'Patient',
    id,
    identifier: [{ system: LifeLabsIdentifierSystem.PatientId, value: id }],
  }
  if (name != null && name.length > 0) wire['name'] = [{ text: name }]
  return wire
}

/**
 * The R4 `Observation` **wire** for one analytic. `status` is `final` (these
 * are posted results). `code.text` is the analyte name, with a supplementary
 * LifeLabs coding. A numeric result becomes a unitless `valueQuantity` (the
 * source carries no unit), anything else a `valueString`. The reference range
 * keeps its raw text plus parsed `low`/`high` when numeric, and an
 * `abnormalFlag` (when present) becomes an `interpretation`.
 */
const observationWire = (
  a: Analytic,
  subjectId: string | undefined,
  id: string
): Record<string, unknown> => {
  const codeText = a.testItemName ?? a.testName ?? a.testCode ?? 'Unknown'
  const code: Record<string, unknown> = { text: codeText }
  if (a.testCode != null && a.testCode.length > 0) {
    code['coding'] = [
      {
        system: LIFELABS_TEST_SYSTEM,
        code: a.testCode,
        ...(a.testName != null && a.testName.length > 0 ? { display: a.testName } : {}),
      },
    ]
  }

  const wire: Record<string, unknown> = {
    resourceType: 'Observation',
    id,
    status: 'final',
    code,
  }

  if (subjectId != null) wire['subject'] = { reference: `Patient/${subjectId}` }

  const millis = dotNetMillis(a.collectionDate)
  if (millis != null) wire['effectiveDateTime'] = new Date(millis).toISOString()

  const rawValue = a.testResultValue
  if (rawValue != null && rawValue.trim().length > 0) {
    const num = Number(rawValue)
    if (Number.isFinite(num)) {
      wire['valueQuantity'] = { value: num }
    } else {
      wire['valueString'] = rawValue
    }
  }

  if (a.referenceRange != null && a.referenceRange.trim().length > 0) {
    const { low, high } = parseReferenceRange(a.referenceRange)
    const range: Record<string, unknown> = { text: a.referenceRange }
    if (low != null) range['low'] = { value: low }
    if (high != null) range['high'] = { value: high }
    wire['referenceRange'] = [range]
  }

  if (a.abnormalFlag != null && a.abnormalFlag.length > 0) {
    wire['interpretation'] = [{ text: a.abnormalFlag }]
  }

  return wire
}

/**
 * The exact analytic-summary XHR URL, anchored and pinned to the Ontario API
 * host and the full `/api/Report/GetAnalyticSummary` path, with an optional
 * query. No prefix or suffix segment (nor a bare trailing slash) is tolerated.
 * Ontario-only for v1 (the `on-api.` host); other provinces are a follow-up.
 */
const analyticSummaryUrl =
  /^https:\/\/on-api\.mycarecompass\.lifelabs\.com\/api\/Report\/GetAnalyticSummary(?:\?|$)/

/**
 * Entity for the MyCareCompass analytics page's single XHR: the
 * `GetAnalyticSummary` payload the SPA fires when
 * `www.on.mycarecompass.lifelabs.com/analytics` loads. A **bespoke, non-FHIR
 * JSON** shape, so this kind decodes it and **synthesizes R4 resources**:
 *
 * - one `Patient` (`id = entity.selectedPatient`, name from the primary patient
 *   row) — only the selected patient, since it is the one the observations
 *   link to; the other `patients[]` rows name people whose results this
 *   response does not carry, and
 * - one `Observation` per `entity.analytics[]` row (`code` from the analyte
 *   name, value as `Quantity`/`String`, effective time from the .NET collection
 *   date, reference range and abnormal flag when present), each `subject`ing the
 *   synthesized Patient.
 *
 * Analytics with no `testCode`/`testItemId` to key a stable logical id are
 * dropped and counted via `Effect.logInfo`, so those losses aren't invisible.
 * {@link extractJson} normalizes the body across raw-XHR intercepts and the
 * mobile WebView's JSON-viewer wrap.
 */
const AnalyticSummaryResponseKind: HttpResponseKind.HttpResponseKind<FhirResource> =
  HttpResponseKind.make({
    name: 'AnalyticSummaryResponseKind',
    tryRecognize: recognizePortal(analyticSummaryUrl, LIFELABS_SYSTEM),
    parse: (response) =>
      Effect.gen(function* () {
        const summary = yield* decodeSummary(extractJson(response.text()))
        const { analytics, patients } = summary.entity
        const selected = summary.entity.selectedPatient
        const subjectId = selected != null ? String(selected) : undefined

        const resources: FhirResource[] = []

        // Synthesize the Patient the observations hang off (id = selectedPatient).
        if (subjectId != null) {
          const primary = patients.find((p) => p.isPrimary === true) ?? patients[0]
          resources.push(yield* decodePatient(patientWire(subjectId, primary?.text)))
        }

        // Each analytic → one R4 Observation; drop (and count) any we can't key.
        let dropped = 0
        for (const a of analytics) {
          const id = observationId(a)
          if (id === undefined) {
            dropped += 1
            continue
          }
          resources.push(yield* decodeObservation(observationWire(a, subjectId, id)))
        }
        if (dropped > 0) {
          yield* Effect.logInfo(
            `AnalyticSummaryResponseKind: dropped ${dropped} of ${analytics.length} analytics with no test code/item id to key an Observation`
          )
        }

        return resources
      }),
  })

export { AnalyticSummaryResponseKind, AnalyticSummaryPayload }
