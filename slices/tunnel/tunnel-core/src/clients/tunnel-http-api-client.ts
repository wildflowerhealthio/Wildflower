import { defineSliceHttpClient } from 'shared-structures-core/http-api-definition'

import { TunnelAdminApi } from '../http-api-definition/index.ts'

const sliceClient = defineSliceHttpClient({
  name: 'TunnelAdminHttpApiClient',
  api: TunnelAdminApi,
})

/**
 * Effect Service providing the resolved `TunnelAdminApi` (owner-only) HttpApi
 * client — `GetTunnel` + `ReplaceTunnel`. The host gates the `/tunnel` surface
 * behind the gatekeeper Owner check. The client itself sets no `Authorization`
 * header — the host app's `HttpClient` layer carries the credential. Adapter layers (`tunnel-react`) provide `.layer`; call
 * sites consume Effect-natively.
 */
class TunnelAdminHttpApiClient extends sliceClient.ClientTag<TunnelAdminHttpApiClient>() {
  static readonly layer = sliceClient.makeLayerFactory(TunnelAdminHttpApiClient)()
}

/**
 * Resolved client shape — keyed off the Tag's `Service` accessor so a change to
 * the underlying HttpApi flows through to consumers without re-deriving via
 * `HttpApiClient.make`.
 */
type TunnelAdminHttpApiClientShape = typeof TunnelAdminHttpApiClient.Service

export { TunnelAdminHttpApiClient, type TunnelAdminHttpApiClientShape }
