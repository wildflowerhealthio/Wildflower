import { HttpApiClient, HttpClient, HttpClientRequest } from '@effect/platform'
import { Effect, Layer } from 'effect'
import { BearerToken } from 'kitchen-sink/auth-token'
import { WebApiOrigin } from 'shared-structures-react'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import { TunnelAdminApi } from 'tunnel-core/http-api-definition'

/**
 * Union of services a `TunnelAdminHttpApiClient` consumer needs in
 * context. The slice's layer leaves `HttpClient`, `BearerToken`, and
 * `WebApiOrigin` unprovided so apps share one of each across every
 * slice's client layer.
 */
type TunnelAdminClientRequirements =
  | HttpClient.HttpClient
  | TunnelAdminHttpApiClient
  | BearerToken
  | WebApiOrigin

/**
 * Build a `TunnelAdminHttpApiClient` layer that prepends the live
 * {@link WebApiOrigin} and attaches the {@link BearerToken} on every
 * request. The `transformClient` closes over both Subscribables resolved
 * at layer-resolution time; each `.get` runs *per request*, so an origin
 * re-point or a token rotation surfaces immediately — no layer rebuild,
 * no client rebuild. Mirrors `defineSliceHttpClient`'s bearer branch
 * (tunnel hand-rolls its client rather than going through that helper).
 *
 * `baseUrl: '/'` keeps request URLs relative; the per-request
 * `prependUrl` makes the absolute target follow `WebApiOrigin` (the host
 * can point the SPA's API calls at the loopback server even when the
 * page is served from a remote dev origin) rather than the page's own
 * origin.
 *
 * `TunnelAdminApi` is composed under `RequireAuthMiddleware` by the
 * host server (e.g. `wildflower-server`); without a bearer the request
 * is rejected, so this layer always attaches one when available.
 */
const buildTunnelAdminClientLayer = (): Layer.Layer<
  TunnelAdminHttpApiClient,
  never,
  HttpClient.HttpClient | BearerToken | WebApiOrigin
> =>
  Layer.effect(
    TunnelAdminHttpApiClient,
    Effect.gen(function* () {
      const tokenSubscribable = yield* BearerToken
      const originSubscribable = yield* WebApiOrigin
      return yield* HttpApiClient.make(TunnelAdminApi, {
        baseUrl: '/',
        transformClient: (c) =>
          HttpClient.mapRequestEffect(c, (request) =>
            Effect.gen(function* () {
              const origin = yield* originSubscribable.get
              const withOrigin = HttpClientRequest.prependUrl(request, origin)
              const token = yield* tokenSubscribable.get
              return token === null
                ? withOrigin
                : HttpClientRequest.setHeader(withOrigin, 'Authorization', `Bearer ${token}`)
            })
          ),
      })
    })
  )

export { buildTunnelAdminClientLayer, type TunnelAdminClientRequirements }
