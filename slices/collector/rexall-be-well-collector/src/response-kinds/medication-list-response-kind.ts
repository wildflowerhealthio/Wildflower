import { Effect, Schema } from 'effect'
import { Bundle, MedicationDispense, MedicationRequest } from 'fhir-stu3-as-r4/schemas'
import { HttpResponseKind, recognizePortal, UrlMatch } from 'http-extraction-fundamentals'

import { extractJson } from '../extract-json.ts'
import { promoteMedicationDispense, promoteMedicationRequest } from '../promote.ts'
import { REXALL_CAREBOOK_SYSTEM } from '../source-system.ts'

/**
 * A parsed medication resource: the decoded output of either carebook
 * `R4FromStu3Schema` transform — an fhir-r4 `MedicationRequest` or
 * `MedicationDispense`. Both are members of `FhirResource`, so the plan can hold
 * them alongside the profile `Patient` under one `ScrapingPlan<FhirResource>`.
 */
type MedicationResource =
  | Schema.Schema.Type<typeof MedicationRequest.R4FromStu3Schema>
  | Schema.Schema.Type<typeof MedicationDispense.R4FromStu3Schema>

/**
 * A searchset entry that is *not* a carebook medication — the matched
 * `Location`, or a `DocumentReference` / `Immunization` `_revinclude`. It
 * decodes to `null` so the whole heterogeneous bundle parses "as is" (a plain
 * two-member medication union would `OrNullAsOptional`-fail the entire bundle on
 * the first non-medication entry); the `null`s are then dropped-and-counted
 * below. `Schema.Unknown` matches anything, so this member **must stay last** in
 * {@link medicationOrNull} — the medication transforms are tried first and only
 * a non-medication resource falls through to here (verified in the entity test).
 */
const NonMedicationResource: Schema.Schema<null, unknown> = Schema.transform(
  Schema.Unknown,
  Schema.Null,
  {
    strict: true,
    decode: () => null,
    encode: () => null,
  }
)

/**
 * Per-entry resource schema for the prescriptions searchset: decode a carebook
 * STU3 `MedicationRequest` / `MedicationDispense` straight to its fhir-r4 shape,
 * or `null` for any other resource type. Order matters — the two medication
 * transforms (each pinned to its own `resourceType` literal) are tried before
 * the always-succeeding {@link NonMedicationResource} catch-all.
 */
const medicationOrNull = Schema.Union(
  MedicationRequest.R4FromStu3Schema,
  MedicationDispense.R4FromStu3Schema,
  NonMedicationResource
)

const MedicationListBundle = Bundle.searchsetBundle(medicationOrNull)
const decode = Schema.decode(Schema.parseJson(MedicationListBundle))

const isMedication = (resource: MedicationResource | null): resource is MedicationResource =>
  resource !== null

/**
 * Move the carebook extensions that have a conventional R4 home into it. Runs
 * after the generic STU3→R4 transform, so `fhir-stu3-as-r4` stays generic and
 * bidirectional — see `promote.ts` for what moves and what deliberately does
 * not.
 */
const promote = (resource: MedicationResource): MedicationResource =>
  resource.resourceType === 'MedicationRequest'
    ? promoteMedicationRequest(resource)
    : promoteMedicationDispense(resource)

/**
 * `…://host/…/pharmacy/Location?…`. The `mustHaveQuery` boundary keeps this
 * list-searchset pattern disjoint from any single-resource pattern (and from
 * `ProfileResponseKind`'s `…/profile/v2/me`), so `ScrapingPlan.responseKinds`
 * ordering is not load-bearing.
 */
const medicationListUrl = UrlMatch.make({
  segments: [UrlMatch.literal('pharmacy'), UrlMatch.literal('Location')],
  end: 'mustHaveQuery',
})

/**
 * Response kind for the Rexall prescriptions page's single XHR: the carebook STU3
 * searchset the SPA fires when `app.letsbewell.ca/health/prescriptions` loads
 * (`…/pharmacy/Location?_revinclude=MedicationRequest…`). It is one
 * *heterogeneous* Bundle — the matched `Location` plus `MedicationRequest`,
 * `MedicationDispense`, `DocumentReference`, and `Immunization` `_revinclude`s.
 *
 * `parse` decodes the bundle "as is" through {@link MedicationListBundle} (whose
 * per-entry union transforms carebook medications to R4 and drops everything
 * else to `null`), then splits off just the `MedicationRequest` /
 * `MedicationDispense` resources — the store only writes those. The dropped
 * non-medication entries are surfaced via `Effect.logInfo` so those losses
 * aren't invisible, exactly the `ObservationListResponseKind` drop-and-log pattern.
 * {@link extractJson} normalizes the body across raw-XHR intercepts and the
 * mobile WebView's JSON-viewer wrap.
 *
 * `followUpSteps` is intentionally omitted: v1 ships list-only. The list
 * `_revinclude` already carries `MedicationDispense`, so the per-medication
 * detail crawl (one `Open` per `MedicationRequest.id` →
 * `…/prescriptions/details/{id}`) is deferred until a capture diff proves the
 * detail XHR is richer. Adding it later is a pure, additive `followUpSteps`
 * method here — no structural change (see issue #339).
 */
const MedicationListResponseKind: HttpResponseKind.HttpResponseKind<MedicationResource> =
  HttpResponseKind.make({
    name: 'MedicationListResponseKind',
    tryRecognize: recognizePortal(medicationListUrl, REXALL_CAREBOOK_SYSTEM),
    parse: (response) =>
      Effect.gen(function* () {
        const bundle = yield* decode(extractJson(response.text()))
        const allEntries = bundle.entry ?? []
        const resources = allEntries
          .map(({ resource }) => resource)
          .filter((resource) => isMedication(resource))
          .map(promote)
        const droppedCount = allEntries.length - resources.length
        if (droppedCount > 0) {
          yield* Effect.logInfo(
            `MedicationListResponseKind: dropped ${droppedCount} of ${allEntries.length} Bundle entries that are not MedicationRequest/MedicationDispense`
          )
        }
        return resources
      }),
  })

export { MedicationListResponseKind }
export type { MedicationResource }
