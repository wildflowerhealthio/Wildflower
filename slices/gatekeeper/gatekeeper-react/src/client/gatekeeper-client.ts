import { HttpApiClient, HttpClient, HttpClientRequest } from '@effect/platform'
import { Effect, Layer } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { GatekeeperApi } from 'gatekeeper-core/http-api-definition'
import { BearerToken } from 'react-kitchen-sink'

/**
 * Union of services a `GatekeeperHttpApiClient` consumer needs in
 * context. The slice's layer leaves `HttpClient` and `BearerToken`
 * unprovided so apps share one of each across every slice's client
 * layer.
 */
type GatekeeperClientRequirements = HttpClient.HttpClient | GatekeeperHttpApiClient | BearerToken

/**
 * Build a `GatekeeperHttpApiClient` layer that reads the bearer token
 * from the {@link BearerToken} service on every request. The
 * `transformClient` closes over the Subscribable resolved at
 * layer-resolution time; `Subscribable.get` runs *per request*, so a
 * token rotation surfaces immediately — no layer rebuild, no client
 * rebuild.
 */
const buildGatekeeperClientLayer = (): Layer.Layer<
  GatekeeperHttpApiClient,
  never,
  HttpClient.HttpClient | BearerToken
> =>
  Layer.effect(
    GatekeeperHttpApiClient,
    Effect.gen(function* () {
      const tokenSubscribable = yield* BearerToken
      return yield* HttpApiClient.make(GatekeeperApi, {
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

/**
 * Returns a function that maps an `HttpClient` to a new one that
 * attaches `Authorization: Bearer <token>` on every request, with
 * `token` fixed at the time of the call.
 *
 * @deprecated For clients that participate in the slice's auth flow,
 * use the {@link BearerToken} service + {@link buildGatekeeperClientLayer}
 * pattern — token rotation is then automatic. This static-token form is
 * kept for ad-hoc consumers (e.g. collector-react's PR-3 layer that
 * still takes a `token` parameter) until they migrate.
 */
const makeBearerTokenClientTransformer =
  (token: string) =>
  (c: HttpClient.HttpClient): HttpClient.HttpClient =>
    HttpClient.mapRequest(c, (request) =>
      HttpClientRequest.setHeader(request, 'Authorization', `Bearer ${token}`)
    )

export {
  buildGatekeeperClientLayer,
  makeBearerTokenClientTransformer,
  type GatekeeperClientRequirements,
}
