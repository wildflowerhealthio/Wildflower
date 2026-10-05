import { defineSliceHttpClient } from 'shared-structures-core/http-api-definition'

import { RelayAdminApi } from '../http-api-definition/index.ts'

const sliceClient = defineSliceHttpClient({
  name: 'RelayAdminHttpApiClient',
  api: RelayAdminApi,
})

/**
 * Effect Service providing the resolved `RelayAdminApi` client —
 * `CreateTunnel`, `ListTunnels` and `DeleteTunnel`. The client signs nothing
 * itself: the `HttpClient` it is built over does (`signingHttpClient` in
 * `relay-core/signing`), so every call carries a signature.
 */
class RelayAdminHttpApiClient extends sliceClient.ClientTag<RelayAdminHttpApiClient>() {
  static readonly layer = sliceClient.makeLayerFactory(RelayAdminHttpApiClient)()
}

/** Resolved client shape, keyed off the Tag's `Service` accessor. */
type RelayAdminHttpApiClientShape = typeof RelayAdminHttpApiClient.Service

export { RelayAdminHttpApiClient, type RelayAdminHttpApiClientShape }
