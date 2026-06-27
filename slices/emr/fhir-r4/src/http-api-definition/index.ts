import { HttpApi, type HttpApiError } from '@effect/platform'
import * as Binary from './binary.ts'
import * as Observation from './observation.ts'
import * as Patient from './patient.ts'

const FhirResourcesApiPrefix = '/fhir-r4'

const FhirResourcesApi: HttpApi.HttpApi<
  'FhirResourcesApi',
  typeof Patient.httpApiGroup | typeof Binary.httpApiGroup | typeof Observation.httpApiGroup,
  HttpApiError.HttpApiDecodeError
> = HttpApi.make('FhirResourcesApi')
  .add(Patient.httpApiGroup)
  .add(Binary.httpApiGroup)
  .add(Observation.httpApiGroup)
  .prefix(FhirResourcesApiPrefix)

export { FhirResourcesApi, FhirResourcesApiPrefix, Binary, Observation, Patient }
