import { Effect, Schema } from 'effect'
import { Bundle, MedicationDispense, MedicationRequest } from 'fhir-stu3-as-r4/schemas'
import { HttpResponseKind, extractJson, recognizePortal } from 'http-extraction-fundamentals'
import { promoteMedicationDispense, promoteMedicationRequest } from '../promote.ts'
import { REXALL_CAREBOOK_SYSTEM } from '../source-system.ts'

/** A decoded carebook medication: an fhir-r4 `MedicationRequest` or `MedicationDispense`. */
type MedicationResource =
  | Schema.Schema.Type<typeof MedicationRequest.R4FromStu3Schema>
  | Schema.Schema.Type<typeof MedicationDispense.R4FromStu3Schema>

/**
 * A non-medication searchset entry (the matched `Location`, or a
 * `DocumentReference` / `Immunization` `_revinclude`), decoded to `null` so the
 * heterogeneous bundle parses "as is". `Schema.Unknown` matches anything, so
 * this **must stay last** in {@link medicationOrNull}.
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
 * the generic STU3→R4 transform. See `promote.ts`.
 */
const promote = (resource: MedicationResource): MedicationResource =>
  resource.resourceType === 'MedicationRequest'
    ? promoteMedicationRequest(resource)
    : promoteMedicationDispense(resource)

/**
 * The exact prescriptions-searchset XHR URL, anchored and pinned to host + `v1`
 * + full path; the trailing `?` requires a query. Disjoint from
 * `ProfileResponseKind`.
 */
const medicationListUrl =
  /^https:\/\/rexall-prd-tunnel\.letsbewell\.ca\/enduser\/health\/v1\/fhir\/stu3\/pharmacy\/Location\?/

/**
 * Response kind for the Rexall prescriptions page's single XHR: one
 * heterogeneous carebook STU3 searchset (matched `Location` plus medication and
 * other `_revinclude`s). `parse` decodes it "as is", keeps only the
 * `MedicationRequest` / `MedicationDispense` resources, and drops-and-logs the
 * rest. `followUpSteps` is omitted — v1 is list-only (#339).
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
