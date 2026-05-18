import { HttpApiClient, HttpClient, HttpClientRequest } from '@effect/platform'
import { Effect, Layer } from 'effect'
import { BearerToken } from 'react-kitchen-sink'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import { TunnelAdminApi } from 'tunnel-core/http-api-definition'

/**
 * Union of services a `TunnelAdminHttpApiClient` consumer needs in
 * context. `TunnelAdminApi` requires auth, so `BearerToken` is part of
 * the surface; `HttpClient` is left unprovided so apps share one across
 * every slice's client layer.
 */
type TunnelAdminClientRequirements = HttpClient.HttpClient | TunnelAdminHttpApiClient | BearerToken

/**
 * Build the admin `TunnelAdminHttpApiClient` layer that reads the bearer
 * token from the {@link BearerToken} service on every request. Mirrors
 * `apps-react/src/client/apps-client.ts`'s admin layer.
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
