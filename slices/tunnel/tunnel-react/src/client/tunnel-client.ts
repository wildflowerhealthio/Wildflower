import { HttpApiClient, HttpClient, HttpClientRequest } from '@effect/platform'
import { Effect, Layer } from 'effect'
import { BearerToken } from 'kitchen-sink/auth-token'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import { TunnelAdminApi } from 'tunnel-core/http-api-definition'

/**
 * Union of services a `TunnelAdminHttpApiClient` consumer needs in
 * context. The slice's layer leaves `HttpClient` and `BearerToken`
 * unprovided so apps share one of each across every slice's client
 * layer.
 */
type TunnelAdminClientRequirements = HttpClient.HttpClient | TunnelAdminHttpApiClient | BearerToken

/**
 * Build a `TunnelAdminHttpApiClient` layer that reads the bearer token
 * from the {@link BearerToken} service on every request. The
 * `transformClient` closes over the Subscribable resolved at
 * layer-resolution time; `Subscribable.get` runs *per request*, so a
 * token rotation surfaces immediately — no layer rebuild, no client
 * rebuild. Mirrors `gatekeeper-react/src/client/gatekeeper-client.ts`.
 *
 * `TunnelAdminApi` is composed under `RequireAuthMiddleware` by the
 * host server (e.g. `wildflower-server`); without a bearer the request
 * is rejected, so this layer always attaches one when available.
 */
const buildTunnelAdminClientLayer = (): Layer.Layer<
  TunnelAdminHttpApiClient,
  never,
  HttpClient.HttpClient | BearerToken
> =>
  Layer.effect(
    TunnelAdminHttpApiClient,
    Effect.gen(function* () {
      const tokenSubscribable = yield* BearerToken
      return yield* HttpApiClient.make(TunnelAdminApi, {
        baseUrl: '/',
        transformClient: (c) =>
          HttpClient.mapRequestEffect(c, (request) =>
            Effect.map(tokenSubscribable.get, (token) =>
              token === null
                ? request
                : HttpClientRequest.setHeader(request, 'Authorization', `Bearer ${token}`)
            )
          ),
      })
    })
  )

export { buildTunnelAdminClientLayer, type TunnelAdminClientRequirements }
