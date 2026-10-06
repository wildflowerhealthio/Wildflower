import { defineSliceHttpClient } from 'shared-structures-core/http-api-definition'

import { RequestLogApi } from '../http-api-definition/index.ts'

const sliceClient = defineSliceHttpClient({
  name: 'RequestLogHttpApiClient',
  api: RequestLogApi,
})

/**
 * Effect Service providing the resolved `RequestLogApi` HttpApi client —
 * `ListCallers` + `ListRequests`. The host authenticates the `/requests`
 * surface behind the gatekeeper bearer gate, then authorizes it by
 * `wildflower/RequestLog.r`. The client itself sets no `Authorization` header —
 * the host app's `HttpClient` layer carries the credential. Adapter layers
 * (`request-log-react`) provide `.layer`; call sites consume Effect-natively.
 */
class RequestLogHttpApiClient extends sliceClient.ClientTag<RequestLogHttpApiClient>() {
  static readonly layer = sliceClient.makeLayerFactory(RequestLogHttpApiClient)()
}

/**
 * Resolved client shape — keyed off the Tag's `Service` accessor so a change to
 * the underlying HttpApi flows through to consumers without re-deriving via
 * `HttpApiClient.make`.
 */
type RequestLogHttpApiClientShape = typeof RequestLogHttpApiClient.Service

export { RequestLogHttpApiClient, type RequestLogHttpApiClientShape }
