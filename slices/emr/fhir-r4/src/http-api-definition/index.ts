import { HttpApi, type HttpApiError } from '@effect/platform'
import * as Binary from './binary.ts'
import * as Observation from './observation.ts'
import * as Patient from './patient.ts'
import * as SmartConfiguration from './smart-configuration.ts'

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

const FhirPublicApi: HttpApi.HttpApi<
  'FhirPublicApi',
  typeof SmartConfiguration.httpApiGroup,
  HttpApiError.HttpApiDecodeError
> = HttpApi.make('FhirPublicApi')
  .add(SmartConfiguration.httpApiGroup)
  .prefix(FhirResourcesApiPrefix)

export {
  FhirResourcesApi,
  FhirPublicApi,
  FhirResourcesApiPrefix,
  Binary,
  Observation,
  Patient,
  SmartConfiguration,
}
