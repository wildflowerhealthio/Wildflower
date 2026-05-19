import { defineSliceHttpClient } from 'shared-structures-core/http-api-definition'

import { CollectorApi } from '../http-api-definition/index.ts'

const sliceClient = defineSliceHttpClient({
  name: 'CollectorHttpApiClient',
  api: CollectorApi,
  auth: 'bearer',
})

/**
 * Effect Service providing the resolved `CollectorApi` HttpApi client.
 * `collector-react` provides it via `<CollectorClientProvider>`
 * (mirrors `GatekeeperHttpApiClient` from `gatekeeper-core/clients`);
 * call sites consume it Effect-natively.
 *
 * @example
 * ```ts
 * Effect.flatMap(CollectorHttpApiClient, (c) =>
 *   c['collector-remotes'].ListRemotes()
 * )
 * ```
 */
class CollectorHttpApiClient extends sliceClient.ClientTag<CollectorHttpApiClient>() {
  static readonly layer = sliceClient.makeLayerFactory(CollectorHttpApiClient)()
  static readonly auth = sliceClient.auth
}

type CollectorHttpApiClientShape = typeof CollectorHttpApiClient.Service

export { CollectorHttpApiClient, type CollectorHttpApiClientShape }
