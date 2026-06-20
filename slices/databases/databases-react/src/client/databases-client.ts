import { HttpApiClient, HttpClient, HttpClientRequest } from '@effect/platform'
import { DatabasesHttpApiClient } from 'databases-core/clients'
import { DatabasesApi } from 'databases-core/http-api-definition'
import { Effect, Layer } from 'effect'
import { BearerToken } from 'kitchen-sink/auth-token'

/**
 * Union of services a `DatabasesHttpApiClient` consumer needs in context. The
 * slice's layer leaves `HttpClient` and `BearerToken` unprovided so apps share
 * one of each across every slice's client layer.
 */
type DatabasesClientRequirements = HttpClient.HttpClient | DatabasesHttpApiClient | BearerToken

/**
 * Build a `DatabasesHttpApiClient` layer that reads the bearer token from the
 * {@link BearerToken} service on every request. The `transformClient` closes
 * over the Subscribable resolved at layer-resolution time; `Subscribable.get`
 * runs *per request*, so a token rotation surfaces immediately — no layer
 * rebuild, no client rebuild. Mirrors `tunnel-react/src/client/tunnel-client.ts`.
 *
 * The host serves `/databases` behind the gatekeeper Owner check, so this layer
 * always attaches a bearer when available.
 */
const buildDatabasesClientLayer = (): Layer.Layer<
  DatabasesHttpApiClient,
  never,
  HttpClient.HttpClient | BearerToken
> =>
  Layer.effect(
    DatabasesHttpApiClient,
    Effect.gen(function* () {
      const tokenSubscribable = yield* BearerToken
      return yield* HttpApiClient.make(DatabasesApi, {
        transformClient: (client) =>
          HttpClient.mapRequestEffect(client, (request) =>
            Effect.map(tokenSubscribable.get, (token) =>
              token === null
                ? request
                : HttpClientRequest.setHeader(request, 'Authorization', `Bearer ${token}`)
            )
          ),
      })
    })
  )

export { buildDatabasesClientLayer, type DatabasesClientRequirements }
