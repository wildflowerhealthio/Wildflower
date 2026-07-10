import { HttpApi, type HttpApiError } from '@effect/platform'
import * as Binary from './binary.ts'
import * as MedicationDispense from './medication-dispense.ts'
import * as MedicationRequest from './medication-request.ts'
import * as Observation from './observation.ts'
import * as Patient from './patient.ts'

const FhirResourcesApiPrefix = '/fhir-r4'

const FhirResourcesApi: HttpApi.HttpApi<
  'FhirResourcesApi',
  | typeof Patient.httpApiGroup
  | typeof Binary.httpApiGroup
  | typeof Observation.httpApiGroup
  | typeof MedicationRequest.httpApiGroup
  | typeof MedicationDispense.httpApiGroup,
  HttpApiError.HttpApiDecodeError
> = HttpApi.make('FhirResourcesApi')
  .add(Patient.httpApiGroup)
  .add(Binary.httpApiGroup)
  .add(Observation.httpApiGroup)
  .add(MedicationRequest.httpApiGroup)
  .add(MedicationDispense.httpApiGroup)
  .prefix(FhirResourcesApiPrefix)

export {
  FhirResourcesApi,
  FhirResourcesApiPrefix,
  Binary,
  MedicationDispense,
  MedicationRequest,
  Observation,
  Patient,
}
