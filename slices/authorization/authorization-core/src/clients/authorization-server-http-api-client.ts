import { defineSliceHttpClient } from '@wildflowerhealthio/shared-structures-core/http-api-definition'

import { AuthorizationServerApi } from '../http-api-definition/index.ts'

const sliceClient = defineSliceHttpClient({
  name: 'AuthorizationServerHttpApiClient',
  api: AuthorizationServerApi,
})

/**
 * Effect Service providing the resolved `AuthorizationServerApi` HttpApi client.
 * Adapter layers (`authorization-react`) provide it; call
 * sites consume Effect-natively.
 *
 * @example
 * ```ts
 * Effect.flatMap(AuthorizationServerHttpApiClient, (c) =>
 *   c['access-management'].ListGrants()
 * )
 * ```
 */
class AuthorizationServerHttpApiClient extends sliceClient.ClientTag<AuthorizationServerHttpApiClient>() {
  static readonly layer = sliceClient.makeLayerFactory(AuthorizationServerHttpApiClient)()
}

/**
 * Resolved client shape — keyed off the Tag's `Service` accessor so a
 * change to the underlying HttpApi flows through to consumers without
 * re-deriving via `HttpApiClient.make`.
 */
type AuthorizationServerHttpApiClientShape = typeof AuthorizationServerHttpApiClient.Service

export { AuthorizationServerHttpApiClient, type AuthorizationServerHttpApiClientShape }
