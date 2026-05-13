import { HttpApiClient, HttpClient, HttpClientRequest } from '@effect/platform'
import { CollectorHttpApiClient } from 'collector-core/clients'
import { CollectorApi } from 'collector-core/http-api-definition'
import { Effect, Layer } from 'effect'
import { BearerToken } from 'react-kitchen-sink'

/**
 * Union of services a `CollectorHttpApiClient` consumer needs in
 * context. The slice's layer leaves `HttpClient` and `BearerToken`
 * unprovided so apps share one of each across every slice's client
 * layer.
 */
type CollectorClientRequirements = HttpClient.HttpClient | CollectorHttpApiClient | BearerToken

/**
 * Build a `CollectorHttpApiClient` layer that reads the bearer token
 * from the {@link BearerToken} service on every request. The
 * `transformClient` closes over the Subscribable resolved at
 * layer-resolution time; `Subscribable.get` runs *per request*, so a
 * token rotation surfaces immediately — no layer rebuild, no client
 * rebuild.
 */
const buildCollectorClientLayer = (): Layer.Layer<
  CollectorHttpApiClient,
  never,
  HttpClient.HttpClient | BearerToken
> =>
  Layer.effect(
    CollectorHttpApiClient,
    Effect.gen(function* () {
      const tokenSubscribable = yield* BearerToken
      return yield* HttpApiClient.make(CollectorApi, {
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

export { buildCollectorClientLayer, type CollectorClientRequirements }
