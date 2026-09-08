import { Effect, Schema } from 'effect'
import { Observation, Patient } from 'fhir-r4/resources'
import type { FhirResource } from 'fhir-r4/resources'
import { HttpResponseKind, extractJson, recognizePortal } from 'http-extraction-fundamentals'

import { LifeLabsIdentifierSystem } from '../lifelabs.ts'
import { LIFELABS_SYSTEM } from '../source-system.ts'
import {
  analyteCodeWire,
  analyteObservationId,
  collectionMillis,
  loincFromTestItemId,
  quantityWire,
  referenceRangeWire,
} from './analyte-observation.ts'

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
 * The key one analytic's logical id is built from (see `analyteObservationId`):
 * `testItemId` (unique per analyte) — or, when the capture omits it, `testCode`
 * **plus the analyte name**. `undefined` when there is no code at all to key on
 * (the caller drops-and-counts those).
 *
 * @remarks
 * `testCode` alone is a *panel* code: WBC and Hemoglobin off one Complete
 * Blood Count share it and a collection instant, so keying the fallback on it
 * alone gave both rows one logical id and the persist PUT silently overwrote
 * one result with the other.
 */
const observationId = (a: Analytic): string | undefined => {
  const analyte = a.testItemName ?? a.testName
  const base =
    a.testItemId ??
    (a.testCode == null || analyte == null || analyte.length === 0
      ? a.testCode
      : `${a.testCode}_${analyte}`)
  if (base == null || base.length === 0) return undefined
  return analyteObservationId(base, a.collectionDate)
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
 * are posted results). `code` is the analyte (LOINC first, LifeLabs panel code
 * second). A numeric result becomes a `valueQuantity` whose unit, if any, is
 * the researched unit for the analyte's LOINC (this payload carries none),
 * anything else a `valueString`. The reference range keeps its raw text plus
 * parsed bounds, and an `abnormalFlag` (when present) becomes an
 * `interpretation`.
 */
const observationWire = (
  a: Analytic,
  subjectId: string | undefined,
  id: string
): Record<string, unknown> => {
  const wire: Record<string, unknown> = {
    resourceType: 'Observation',
    id,
    status: 'final',
    code: analyteCodeWire(a),
  }

  if (subjectId != null) wire['subject'] = { reference: `Patient/${subjectId}` }

  const millis = collectionMillis(a.collectionDate)
  if (millis != null) wire['effectiveDateTime'] = new Date(millis).toISOString()

  const rawValue = a.testResultValue
  if (rawValue != null && rawValue.trim().length > 0) {
    const loinc = a.testItemId == null ? undefined : loincFromTestItemId(a.testItemId)
    const quantity = quantityWire(rawValue, undefined, loinc)
    if (quantity !== undefined) wire['valueQuantity'] = quantity
    else wire['valueString'] = rawValue
  }

  const range = referenceRangeWire(a.referenceRange)
  if (range !== undefined) wire['referenceRange'] = [range]

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
