import {
  Bundle,
  MedicationDispense,
  MedicationRequest,
} from '@wildflowerhealthio/fhir-stu3-as-r4/schemas'
import {
  HttpResponseKind,
  extractJson,
  recognizePortal,
} from '@wildflowerhealthio/http-extraction-fundamentals'
import { Effect, Predicate, RegExp as EffectRegExp, Schema } from 'effect'
import { promoteMedicationDispense } from '../promote/medication-dispense.ts'
import { promoteMedicationRequest } from '../promote/medication-request.ts'
import { REXALL_CAREBOOK_SYSTEM } from '../source-system.ts'
import { REXALL_PHARMACY_LOCATION_URL, tunnelGetMatcher } from '../tunnel-url.ts'

/** A decoded carebook medication: an fhir-r4 `MedicationRequest` or `MedicationDispense`. */
type MedicationResource =
  | Schema.Schema.Type<typeof MedicationRequest.R4FromStu3Schema>
  | Schema.Schema.Type<typeof MedicationDispense.R4FromStu3Schema>

/** Whether an entry claims to be a medication, whatever else it holds. */
const isMedicationEntry = Schema.is(
  Schema.Struct({ resourceType: Schema.Literal('MedicationRequest', 'MedicationDispense') })
)

/**
 * A non-medication searchset entry (the matched `Location`, or a
 * `DocumentReference` / `Immunization` `_revinclude`), decoded to `null` so the
 * heterogeneous bundle parses "as is". It never claims a `MedicationRequest` /
 * `MedicationDispense`: one that does not decode fails the list rather than
 * dropping out of it unseen. Must stay last in {@link medicationOrNull}.
 */
const NonMedicationResource: Schema.Schema<null, unknown> = Schema.transform(
  Schema.Unknown.pipe(
    Schema.filter(Predicate.not(isMedicationEntry), {
      message: () => 'a MedicationRequest / MedicationDispense that does not decode',
    })
  ),
  Schema.Null,
  {
    strict: true,
    decode: () => null,
    encode: () => null,
  }
)

/**
 * Per-entry searchset schema: a carebook medication decoded straight to fhir-r4,
 * else `null`. Order matters — the medication transforms precede the
 * {@link NonMedicationResource} catch-all.
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
 * Move the carebook extensions that have a conventional R4 home into it, after
 * the generic STU3→R4 transform. See `promote/`.
 */
const promote = (resource: MedicationResource): MedicationResource =>
  resource.resourceType === 'MedicationRequest'
    ? promoteMedicationRequest(resource)
    : promoteMedicationDispense(resource)

/**
 * {@link REXALL_PHARMACY_LOCATION_URL} followed by a query: the
 * prescriptions-searchset XHR, anchored and pinned to host + `v1` + full path;
 * the trailing `?` requires a query. Disjoint from `ProfileResponseKind`.
 */
const medicationListUrl = new RegExp(`^${EffectRegExp.escape(REXALL_PHARMACY_LOCATION_URL)}\\?`)

/**
 * Response kind for the Rexall prescriptions page's single XHR: one
 * heterogeneous carebook STU3 searchset (matched `Location` plus medication and
 * other `_revinclude`s). `parse` decodes it "as is", keeps only the
 * `MedicationRequest` / `MedicationDispense` resources, and drops-and-logs the
 * rest. List-only — no detail crawl (#339).
 */
const MedicationListResponseKind: HttpResponseKind.HttpResponseKind<MedicationResource> =
  HttpResponseKind.make({
    name: 'MedicationListResponseKind',
    tryRecognize: recognizePortal(tunnelGetMatcher(medicationListUrl), REXALL_CAREBOOK_SYSTEM),
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
