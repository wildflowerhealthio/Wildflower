import { defineSliceHttpClient } from 'shared-structures-core/http-api-definition'

import { DatabasesApi } from '../http-api-definition/index.ts'

const sliceClient = defineSliceHttpClient({
  name: 'DatabasesHttpApiClient',
  api: DatabasesApi,
})

/**
 * Effect Service providing the resolved `DatabasesApi` HttpApi client —
 * `ListDatabases` + `DeleteDatabase`. The host authenticates the `/databases`
 * surface behind the gatekeeper bearer gate, then authorizes delete per database
 * by its declared scope. The client itself sets no `Authorization` header — the
 * host app's `HttpClient` layer carries the credential.
 * Adapter layers (`databases-react`) provide `.layer`; call sites consume
 * Effect-natively.
 */
class DatabasesHttpApiClient extends sliceClient.ClientTag<DatabasesHttpApiClient>() {
  static readonly layer = sliceClient.makeLayerFactory(DatabasesHttpApiClient)()
}

/**
 * Resolved client shape — keyed off the Tag's `Service` accessor so a change to
 * the underlying HttpApi flows through to consumers without re-deriving via
 * `HttpApiClient.make`.
 */
type DatabasesHttpApiClientShape = typeof DatabasesHttpApiClient.Service

export { DatabasesHttpApiClient, type DatabasesHttpApiClientShape }
