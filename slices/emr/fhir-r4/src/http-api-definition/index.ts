import { HttpApi, type HttpApiError } from '@effect/platform'
import * as Binary from './binary.ts'
import * as DocumentReference from './document-reference.ts'
import * as MedicationDispense from './medication-dispense.ts'
import * as MedicationRequest from './medication-request.ts'
import * as Observation from './observation.ts'
import * as Patient from './patient.ts'

/**
 * The path Wildflower's host mounts `emr-rust` at.
 *
 * @remarks
 * No longer baked into {@link FhirResourcesApi} — the typed client emits
 * base-relative FHIR paths (`/Patient`, not `/fhir-r4/Patient`) so it can be
 * pointed at any FHIR server. This prefix is re-applied only by the two
 * consumers that know they are talking to Wildflower's own host: the host app's
 * client wiring (`apps/wildflower-react`'s `router-context.ts`) and the OpenAPI
 * snapshot generation (`openapi-drift.test.ts`), which keeps the committed
 * `emr-rust/openapi/fhir-r4.openapi.json` — the `/docs` page's source — showing
 * the mounted paths.
 */
const FhirResourcesApiPrefix = '/fhir-r4'

const FhirResourcesApi: HttpApi.HttpApi<
  'FhirResourcesApi',
  | typeof Patient.httpApiGroup
  | typeof Binary.httpApiGroup
  | typeof Observation.httpApiGroup
  | typeof MedicationRequest.httpApiGroup
  | typeof MedicationDispense.httpApiGroup
  | typeof DocumentReference.httpApiGroup,
  HttpApiError.HttpApiDecodeError
> = HttpApi.make('FhirResourcesApi')
  .add(Patient.httpApiGroup)
  .add(Binary.httpApiGroup)
  .add(Observation.httpApiGroup)
  .add(MedicationRequest.httpApiGroup)
  .add(MedicationDispense.httpApiGroup)
  .add(DocumentReference.httpApiGroup)

export {
  FhirResourcesApi,
  FhirResourcesApiPrefix,
  Binary,
  DocumentReference,
  MedicationDispense,
  MedicationRequest,
  Observation,
  Patient,
}
