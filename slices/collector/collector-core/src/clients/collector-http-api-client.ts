import { defineSliceHttpClient } from 'shared-structures-core/http-api-definition'

import { CollectorApi } from '../http-api-definition/index.ts'

const sliceClient = defineSliceHttpClient({
  name: 'CollectorHttpApiClient',
  api: CollectorApi,
  authType: 'bearer',
})

/**
 * Effect Service providing the resolved `CollectorApi` HttpApi client.
 * `collector-react` exposes it as a per-slice layer
 * (`buildCollectorClientLayer`) that the app merges into its composed
 * `runtimeLayer` (mirrors `GatekeeperHttpApiClient` from
 * `gatekeeper-core/clients`); call sites consume it Effect-natively
 * through the `runAuthed` runner.
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
  static readonly authType = sliceClient.authType
}

type CollectorHttpApiClientShape = typeof CollectorHttpApiClient.Service

export { CollectorHttpApiClient, type CollectorHttpApiClientShape }
