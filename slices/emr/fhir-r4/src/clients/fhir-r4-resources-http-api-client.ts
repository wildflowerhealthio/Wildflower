import { defineSliceHttpClient } from 'shared-structures-core/http-api-definition'

import { FhirResourcesApi } from '../http-api-definition/index.ts'

const sliceClient = defineSliceHttpClient({
  name: 'FhirR4ResourcesHttpApiClient',
  api: FhirResourcesApi,
  auth: 'bearer',
})

/**
 * Effect Service providing the resolved `FhirResourcesApi` HttpApi
 * client. `fhir-r4-react` provides it via
 * `<FhirR4ResourcesClientProvider>` (mirrors `GatekeeperHttpApiClient`
 * from `gatekeeper-core/clients`); call sites consume it
 * Effect-natively.
 *
 * @example
 * ```ts
 * Effect.flatMap(FhirR4ResourcesHttpApiClient, (c) =>
 *   c['patient'].CreatePatient({ payload })
 * )
 * ```
 */
class FhirR4ResourcesHttpApiClient extends sliceClient.ClientTag<FhirR4ResourcesHttpApiClient>() {
  static readonly layer = sliceClient.makeLayerFactory(FhirR4ResourcesHttpApiClient)()
  static readonly auth = sliceClient.auth
}

type FhirR4ResourcesHttpApiClientShape = typeof FhirR4ResourcesHttpApiClient.Service

export { FhirR4ResourcesHttpApiClient, type FhirR4ResourcesHttpApiClientShape }
