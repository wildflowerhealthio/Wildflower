import { HttpApiClient, HttpClient, HttpClientRequest } from '@effect/platform'
import { AppsHttpApiClient } from 'apps-core/clients'
import { AppsApi } from 'apps-core/http-api-definition'
import { Effect, Layer } from 'effect'
import { BearerToken } from 'react-kitchen-sink'

/**
 * Union of services an `AppsHttpApiClient` consumer needs in context.
 * The slice's layer leaves `HttpClient` and `BearerToken` unprovided so
 * apps share one of each across every slice's client layer.
 */
type AppsClientRequirements = HttpClient.HttpClient | AppsHttpApiClient | BearerToken

/**
 * Build an `AppsHttpApiClient` layer that reads the bearer token from
 * the {@link BearerToken} service on every request. The
 * `transformClient` closes over the Subscribable resolved at
 * layer-resolution time; `Subscribable.get` runs *per request*, so a
 * token rotation surfaces immediately — no layer rebuild, no client
 * rebuild.
 */
const buildAppsClientLayer = (): Layer.Layer<
  AppsHttpApiClient,
  never,
  HttpClient.HttpClient | BearerToken
> =>
  Layer.effect(
    AppsHttpApiClient,
    Effect.gen(function* () {
      const tokenSubscribable = yield* BearerToken
      return yield* HttpApiClient.make(AppsApi, {
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

export { buildAppsClientLayer, type AppsClientRequirements }
