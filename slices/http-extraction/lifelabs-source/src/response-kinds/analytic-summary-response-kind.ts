import { Effect, Either, Encoding, Schema } from 'effect'
import { Observation, Patient } from 'fhir-r4/resources'
import type { FhirResource } from 'fhir-r4/resources'
import { HttpResponseKind, extractJson, recognizePortal } from 'http-extraction-fundamentals'

import { LIFELABS_TEST_SYSTEM, LOINC_SYSTEM, LifeLabsIdentifierSystem } from '../lifelabs.ts'
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

/**
 * One row of `entity.patients[]` — the account's patient identities.
 * `patientMap` lists every portal patient id that is the same human (an
 * earlier registration under another name, say), the row's own `value` among
 * them.
 */
const PatientRow = Schema.Struct({
  text: Schema.optional(Schema.NullOr(Schema.String)),
  value: Schema.optional(Schema.NullOr(Schema.Union(Schema.String, Schema.Number))),
  isPrimary: Schema.optional(Schema.NullOr(Schema.Boolean)),
  patientMap: Schema.optionalWith(Schema.Array(Schema.Union(Schema.String, Schema.Number)), {
    default: (): readonly (string | number)[] => [],
    nullable: true,
  }),
})

type PatientRow = typeof PatientRow.Type

/**
 * Just-enough schema for the `GetAnalyticSummary` response envelope. Only the
 * three fields the kind reads (`analytics`, `selectedPatient`, `patients`) are
 * modeled; the rest of the payload (`testItems`, `visitDateRange`, the status
 * envelope) is dropped on decode. `selectedPatient` is the id every synthesized
 * Observation's `subject` references and the synthesized `Patient.id`.
 *
 * Both arrays are `nullable` as well as optional: this .NET API serializes an
 * empty collection as `null` (the same envelope carries `selectedReports:
 * null`), and failing the decode there would drop every result in the response.
 */
const AnalyticSummaryPayload = Schema.Struct({
  entity: Schema.Struct({
    analytics: Schema.optionalWith(Schema.Array(Analytic), {
      default: (): readonly Analytic[] => [],
      nullable: true,
    }),
    selectedPatient: Schema.optional(Schema.NullOr(Schema.Union(Schema.String, Schema.Number))),
    patients: Schema.optionalWith(Schema.Array(PatientRow), {
      default: (): readonly PatientRow[] => [],
      nullable: true,
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
 * The largest epoch-millis value `Date` represents (ECMA-262's time-value
 * range). Past it `toISOString()` throws a `RangeError` — a *defect* inside
 * `parse`, and a defect escapes `Extraction.parseWith`'s fold and takes the
 * whole extraction run down. Bounded here, where an out-of-range token is
 * merely an unusable date.
 */
const MAX_TIME_VALUE = 8_640_000_000_000_000

/**
 * Absolute epoch millis from a collection instant, or `undefined` if
 * unparseable or outside the representable date range. Accepts both a .NET
 * `/Date(1779297900000-0400)/` token (the trailing `±hhmm` is a display-only
 * original offset; the millis are already absolute UTC) and an ISO 8601
 * string (`2023-02-15T13:55:34+00:00`, or offset-less `2016-07-10T18:25:29`,
 * read as UTC) — the portal's sibling report endpoints serialize dates as ISO,
 * so the analytic payload is not assumed to differ.
 */
const collectionMillis = (raw: string | null | undefined): number | undefined => {
  if (raw == null) return undefined
  const m = /\/Date\((-?\d+)(?:[+-]\d{4})?\)\//.exec(raw)
  const millis = m === null ? Date.parse(isoAsUtc(raw)) : Number(m[1])
  return Number.isFinite(millis) && Math.abs(millis) <= MAX_TIME_VALUE ? millis : undefined
}

/**
 * Pin an offset-less ISO date-time to UTC so `Date.parse` doesn't read it in
 * the host's local zone. Leaves anything already carrying `Z` / `±hh:mm` alone.
 */
const isoAsUtc = (raw: string): string =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw) ? `${raw}Z` : raw

/**
 * `4.0 - 11.0` / `120- 160` / `0.350 - 0.450` → numeric `{ low, high }`; a
 * one-sided `<2.6` / `<=2.6` → `{ high }` and `>40` / `>=40` → `{ low }`; a
 * range that is none of these yields `{}` (the raw string is still kept as
 * `referenceRange[].text`).
 */
const parseReferenceRange = (raw: string): { low?: number; high?: number } => {
  const out: { low?: number; high?: number } = {}
  const interval = /^\s*([\d.]+)\s*-\s*([\d.]+)\s*$/.exec(raw)
  if (interval !== null) {
    const low = Number(interval[1])
    const high = Number(interval[2])
    if (Number.isFinite(low)) out.low = low
    if (Number.isFinite(high)) out.high = high
    return out
  }
  const oneSided = /^\s*([<>])=?\s*([\d.]+)\s*$/.exec(raw)
  if (oneSided !== null) {
    const bound = Number(oneSided[2])
    if (Number.isFinite(bound)) {
      if (oneSided[1] === '<') out.high = bound
      else out.low = bound
    }
  }
  return out
}

/**
 * The LOINC code a `testItemId` embeds: the id is base64 of
 * `<testCode>__<loinc>;` (`TR10477-8W__6690-2;` is WBC). `undefined` for an id
 * that is not base64, or whose plaintext is not that shape — the LifeLabs
 * coding still carries the analyte, this one is a bonus.
 */
const loincFromTestItemId = (testItemId: string): string | undefined => {
  const decoded = Encoding.decodeBase64String(testItemId)
  if (Either.isLeft(decoded)) return undefined
  const m = /^[^_]+__(\d{1,5}-\d);?$/.exec(decoded.right)
  return m?.[1]
}

/** FHIR logical ids are at most 64 characters. */
const MAX_FHIR_ID_LENGTH = 64

/**
 * A stable, FHIR-safe logical id for one analytic: the sanitized `testItemId`
 * (unique per analyte) — or, when the capture omits it, `testCode` **plus the
 * analyte name** — suffixed with the collection instant so repeat draws of the
 * same analyte across dates don't collide. `undefined` when there is no code at
 * all to key on (the caller drops-and-counts those).
 *
 * @remarks
 * `testCode` alone is a *panel* code: WBC and Hemoglobin off one Complete
 * Blood Count share it and a collection instant, so keying the fallback on it
 * alone gave both rows one logical id and the persist PUT silently overwrote
 * one result with the other. Truncation keeps the instant suffix rather than
 * an over-long token's tail, which would re-collide the analyte across dates.
 */
const observationId = (a: Analytic): string | undefined => {
  const analyte = a.testItemName ?? a.testName
  const base =
    a.testItemId ??
    (a.testCode == null || analyte == null || analyte.length === 0
      ? a.testCode
      : `${a.testCode}_${analyte}`)
  if (base == null || base.length === 0) return undefined
  const token = toFhirIdToken(base)
  const millis = collectionMillis(a.collectionDate)
  if (millis == null) return token.slice(0, MAX_FHIR_ID_LENGTH)
  const suffix = `-${millis}`
  return `${token.slice(0, MAX_FHIR_ID_LENGTH - suffix.length)}${suffix}`
}

/**
 * The R4 `Patient` **wire** for the selected patient: `id` is the portal's
 * patient id (the id every Observation's `subject` references), carried again
 * as `identifier[0]`, followed by one identifier per *other* id in the row's
 * `patientMap` (the same human's earlier portal ids), and the display name
 * (when present) lands as a single `name[].text` entry — the source gives one
 * combined string, not structured family/given.
 */
const patientWire = (
  id: string,
  name: string | null | undefined,
  patientMap: readonly (string | number)[]
): Record<string, unknown> => {
  const others = [...new Set(patientMap.map(String))].filter((v) => v.length > 0 && v !== id)
  const wire: Record<string, unknown> = {
    resourceType: 'Patient',
    id,
    identifier: [id, ...others].map((value) => ({
      system: LifeLabsIdentifierSystem.PatientId,
      value,
    })),
  }
  if (name != null && name.length > 0) wire['name'] = [{ text: name }]
  return wire
}

/**
 * The R4 `Observation` **wire** for one analytic. `status` is `final` (these
 * are posted results). `code.text` is the analyte name, with a LOINC coding
 * (recovered from `testItemId`) first and LifeLabs' own panel coding second. A numeric result becomes a unitless `valueQuantity` (the
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
  const coding: Record<string, unknown>[] = []
  // LOINC first: the standard code for the analyte, when the item id carries one.
  const loinc = a.testItemId == null ? undefined : loincFromTestItemId(a.testItemId)
  if (loinc !== undefined) {
    coding.push({
      system: LOINC_SYSTEM,
      code: loinc,
      ...(a.testItemName != null && a.testItemName.length > 0 ? { display: a.testItemName } : {}),
    })
  }
  // Then LifeLabs' own panel code, displaying the panel (`testName`).
  if (a.testCode != null && a.testCode.length > 0) {
    coding.push({
      system: LIFELABS_TEST_SYSTEM,
      code: a.testCode,
      ...(a.testName != null && a.testName.length > 0 ? { display: a.testName } : {}),
    })
  }
  if (coding.length > 0) code['coding'] = coding

  const wire: Record<string, unknown> = {
    resourceType: 'Observation',
    id,
    status: 'final',
    code,
  }

  if (subjectId != null) wire['subject'] = { reference: `Patient/${subjectId}` }

  const millis = collectionMillis(a.collectionDate)
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
 * `www.on.mycarecompass.lifelabs.com/analytics` loads. A bespoke, non-FHIR
 * JSON shape, decoded and **synthesized** into the selected `Patient` plus one
 * `Observation` per `entity.analytics[]` row — the field-by-field mapping is
 * in the package AGENTS.md. Analytics with nothing to key a stable logical id
 * are dropped and counted via `Effect.logInfo`. {@link extractJson} normalizes
 * the body across raw-XHR intercepts and the mobile WebView's JSON-viewer wrap.
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
        // Blank is absent: `selectedPatient: ''` would otherwise mint a Patient
        // with an empty logical id and a dangling `Patient/` subject.
        const selectedId = selected == null ? '' : String(selected)
        const subjectId = selectedId.length > 0 ? selectedId : undefined

        const resources: FhirResource[] = []

        // Synthesize the Patient the observations hang off (id = selectedPatient).
        if (subjectId != null) {
          // Matched on id, never on `isPrimary`: on a shared account the primary
          // row names the account holder, not the dependent these results are
          // for. No matching row ⇒ no name, rather than someone else's.
          const selectedRow = patients.find((p) => p.value != null && String(p.value) === subjectId)
          resources.push(
            yield* decodePatient(
              patientWire(subjectId, selectedRow?.text, selectedRow?.patientMap ?? [])
            )
          )
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
