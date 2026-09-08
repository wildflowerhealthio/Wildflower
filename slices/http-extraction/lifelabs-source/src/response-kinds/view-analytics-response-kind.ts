import { Effect, Schema } from 'effect'
import { Observation } from 'fhir-r4/resources'
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
  testCodeFromTestItemId,
} from './analyte-observation.ts'

/**
 * One row of `entity.reports[]` from the MyCareCompass `ViewAnalytics` payload:
 * one draw of the one analyte the request's `testItemIds` names. Lenient like
 * the summary's `Analytic`. `testItemId` / `testItemName` are `null` on every
 * row (the analyte is in the envelope and the URL), the value, range and unit
 * are strings, and `testAbnormal` is the flag (`"L"`, `"H"`) or `null`.
 */
const ReportRow = Schema.Struct({
  reportId: Schema.optional(Schema.NullOr(Schema.Union(Schema.String, Schema.Number))),
  testAbnormal: Schema.optional(Schema.NullOr(Schema.String)),
  collectionDate: Schema.optional(Schema.NullOr(Schema.String)),
  collectionPostedDate: Schema.optional(Schema.NullOr(Schema.String)),
  comments: Schema.optional(Schema.NullOr(Schema.String)),
  testReferenceRange: Schema.optional(Schema.NullOr(Schema.String)),
  testResultValue: Schema.optional(Schema.NullOr(Schema.String)),
  testUnit: Schema.optional(Schema.NullOr(Schema.String)),
})

type ReportRow = typeof ReportRow.Type

/**
 * Just-enough schema for the `ViewAnalytics` envelope: the analyte's names and
 * its `reports[]` history. `showChart`, `testNormalizedResultValue` (the
 * portal's chart position) and the status envelope are dropped on decode.
 */
const ViewAnalyticsPayload = Schema.Struct({
  entity: Schema.Struct({
    testItemName: Schema.optional(Schema.NullOr(Schema.String)),
    testName: Schema.optional(Schema.NullOr(Schema.String)),
    reports: Schema.optionalWith(Schema.Array(ReportRow), {
      default: (): readonly ReportRow[] => [],
      nullable: true,
    }),
  }),
})

const decodeView = Schema.decode(Schema.parseJson(ViewAnalyticsPayload))
const decodeObservation = Schema.decodeUnknown(Observation.Schema)

/**
 * The exact per-analyte history XHR URL, anchored and pinned to the Ontario API
 * host and the full `/api/Report/ViewAnalytics` path. The query is required:
 * it carries the `patientId` and the one `testItemIds` the rows belong to.
 */
const viewAnalyticsUrl =
  /^https:\/\/on-api\.mycarecompass\.lifelabs\.com\/api\/Report\/ViewAnalytics\?/

/**
 * The analyte and patient a `ViewAnalytics` URL is about. `undefined` unless
 * the query names exactly one `testItemIds` value — with several, the rows
 * (whose own `testItemId` is `null`) cannot be attributed to an analyte.
 */
const requestSubject = (
  url: string
): { readonly patientId: string | undefined; readonly testItemId: string } | undefined => {
  const params = new URL(url).searchParams
  const ids = (params.get('testItemIds') ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
  const [testItemId] = ids
  if (testItemId === undefined || ids.length !== 1) return undefined
  const patientId = params.get('patientId')?.trim()
  return {
    patientId: patientId != null && patientId.length > 0 ? patientId : undefined,
    testItemId,
  }
}

/**
 * The R4 `Observation` **wire** for one draw in the history. Same id scheme,
 * `code`, `status`, range and interpretation as the summary kind's rows, plus
 * what only this payload carries: the **unit** (`testUnit`, with its UCUM code
 * when known), the source report's id as an `identifier`, and any `comments`
 * as a `note`.
 */
const observationWire = (
  row: ReportRow,
  names: {
    readonly testItemName: string | null | undefined
    readonly testName: string | null | undefined
  },
  subject: { readonly patientId: string | undefined; readonly testItemId: string },
  id: string
): Record<string, unknown> => {
  const wire: Record<string, unknown> = {
    resourceType: 'Observation',
    id,
    status: 'final',
    code: analyteCodeWire({
      testItemId: subject.testItemId,
      testItemName: names.testItemName,
      testName: names.testName,
      testCode: testCodeFromTestItemId(subject.testItemId),
    }),
  }

  if (row.reportId != null && String(row.reportId).length > 0) {
    wire['identifier'] = [
      { system: LifeLabsIdentifierSystem.ReportId, value: String(row.reportId) },
    ]
  }

  if (subject.patientId !== undefined) {
    wire['subject'] = { reference: `Patient/${subject.patientId}` }
  }

  const millis = collectionMillis(row.collectionDate)
  if (millis != null) wire['effectiveDateTime'] = new Date(millis).toISOString()

  const rawValue = row.testResultValue
  if (rawValue != null && rawValue.trim().length > 0) {
    const quantity = quantityWire(rawValue, row.testUnit, loincFromTestItemId(subject.testItemId))
    if (quantity !== undefined) wire['valueQuantity'] = quantity
    else wire['valueString'] = rawValue
  }

  const range = referenceRangeWire(row.testReferenceRange)
  if (range !== undefined) wire['referenceRange'] = [range]

  if (row.testAbnormal != null && row.testAbnormal.length > 0) {
    wire['interpretation'] = [{ text: row.testAbnormal }]
  }

  if (row.comments != null && row.comments.trim().length > 0) {
    wire['note'] = [{ text: row.comments }]
  }

  return wire
}

/**
 * Entity for the analytics page's per-analyte XHR: the `ViewAnalytics` payload
 * the SPA fires when the user clicks one analyte, carrying that analyte's whole
 * history **with units**. One `Observation` per `reports[]` row, minted through
 * the same helpers as `AnalyticSummaryResponseKind` so a draw already imported
 * from the summary is superseded (same logical id) by its unit-bearing twin
 * rather than duplicated. Emits no `Patient` — the summary does, and a
 * `subject` reference adopts to the same local id whether or not that Patient
 * is in this batch. A URL naming several `testItemIds` yields nothing (the rows
 * cannot be attributed), logged via `Effect.logInfo`.
 */
const ViewAnalyticsResponseKind: HttpResponseKind.HttpResponseKind<FhirResource> =
  HttpResponseKind.make({
    name: 'ViewAnalyticsResponseKind',
    tryRecognize: recognizePortal(viewAnalyticsUrl, LIFELABS_SYSTEM),
    parse: (response) =>
      Effect.gen(function* () {
        const view = yield* decodeView(extractJson(response.text()))
        const subject = requestSubject(response.url)
        if (subject === undefined) {
          yield* Effect.logInfo(
            `ViewAnalyticsResponseKind: skipped ${view.entity.reports.length} rows — the URL does not name exactly one testItemIds`
          )
          return []
        }
        const names = { testItemName: view.entity.testItemName, testName: view.entity.testName }
        const resources: FhirResource[] = []
        for (const row of view.entity.reports) {
          const id = analyteObservationId(subject.testItemId, row.collectionDate)
          resources.push(yield* decodeObservation(observationWire(row, names, subject, id)))
        }
        return resources
      }),
  })

export { ViewAnalyticsResponseKind, ViewAnalyticsPayload }
