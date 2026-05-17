import { HttpApiClient } from '@effect/platform'
import { Context, type Effect } from 'effect'

import { FhirResourcesApi } from '../http-api-definition/index.ts'

// oxlint-disable-next-line no-underscore-dangle
const _bareFhirResourcesClient = HttpApiClient.make(FhirResourcesApi, { baseUrl: '/' })
type FhirR4ResourcesHttpApiClientShape = Effect.Effect.Success<typeof _bareFhirResourcesClient>

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
class FhirR4ResourcesHttpApiClient extends Context.Tag('FhirR4ResourcesHttpApiClient')<
  FhirR4ResourcesHttpApiClient,
  FhirR4ResourcesHttpApiClientShape
>() {}

export { FhirR4ResourcesHttpApiClient, type FhirR4ResourcesHttpApiClientShape }
