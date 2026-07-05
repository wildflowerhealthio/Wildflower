import { defineSliceHttpClient } from 'shared-structures-core/http-api-definition'

import { GatekeeperApi } from '../http-api-definition/index.ts'

const sliceClient = defineSliceHttpClient({
  name: 'GatekeeperHttpApiClient',
  api: GatekeeperApi,
})

/**
 * Effect Service providing the resolved `GatekeeperApi` HttpApi client.
 * Adapter layers (`gatekeeper-react`) provide it; call
 * sites consume Effect-natively.
 *
 * @example
 * ```ts
 * Effect.flatMap(GatekeeperHttpApiClient, (c) =>
 *   c['access-management'].ListGrants()
 * )
 * ```
 */
class GatekeeperHttpApiClient extends sliceClient.ClientTag<GatekeeperHttpApiClient>() {
  static readonly layer = sliceClient.makeLayerFactory(GatekeeperHttpApiClient)()
}

/**
 * Resolved client shape — keyed off the Tag's `Service` accessor so a
 * change to the underlying HttpApi flows through to consumers (e.g.
 * `pollAuthorizationStatus`) without re-deriving via `HttpApiClient.make`.
 */
type GatekeeperHttpApiClientShape = typeof GatekeeperHttpApiClient.Service

export { GatekeeperHttpApiClient, type GatekeeperHttpApiClientShape }
