import { HttpApiClient } from '@effect/platform'
import { Context, type Effect } from 'effect'

import { FhirResourcesApi } from '../http-api-definition/index.ts'

const _bareFhirResourcesClient = HttpApiClient.make(FhirResourcesApi, { baseUrl: '/' })
type FhirResourcesHttpApiClientShape = Effect.Effect.Success<typeof _bareFhirResourcesClient>

/**
 * Effect Service providing the resolved `FhirResourcesApi` HttpApi
 * client. `fhir-r4-react` provides it via
 * `<FhirResourcesClientProvider>` (mirrors `GatekeeperHttpApiClient`
 * from `gatekeeper-core/clients`); call sites consume it
 * Effect-natively.
 *
 * @example
 * ```ts
 * Effect.flatMap(FhirResourcesHttpApiClient, (c) =>
 *   c['patient'].CreatePatient({ payload })
 * )
 * ```
 */
class FhirResourcesHttpApiClient extends Context.Tag('FhirResourcesHttpApiClient')<
  FhirResourcesHttpApiClient,
  FhirResourcesHttpApiClientShape
>() {}

export { FhirResourcesHttpApiClient, type FhirResourcesHttpApiClientShape }
