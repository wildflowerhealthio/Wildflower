import { HttpApiClient, HttpClient, HttpClientRequest } from '@effect/platform'
import { AppsAdminHttpApiClient, AppsHttpApiClient } from 'apps-core/clients'
import { AppsAdminApi, AppsApi } from 'apps-core/http-api-definition'
import { Effect, Layer } from 'effect'
import { BearerToken } from 'react-kitchen-sink'

/**
 * Union of services an `AppsHttpApiClient` consumer needs in context.
 * The slice's public layer leaves `HttpClient` unprovided so apps share
 * one across every slice's client layer. No bearer token — `AppsApi`
 * has no auth.
 */
type AppsClientRequirements = HttpClient.HttpClient | AppsHttpApiClient

/**
 * Union of services an `AppsAdminHttpApiClient` consumer needs in
 * context. Mirrors the public layer plus `BearerToken` (the slice's
 * admin layer reads the live token per request).
 */
type AppsAdminClientRequirements = HttpClient.HttpClient | AppsAdminHttpApiClient | BearerToken

/**
 * Build the public `AppsHttpApiClient` layer. `AppsApi` carries
 * `ListApps` + `LaunchApp` and has *no* auth — this layer deliberately
 * does **not** attach `Authorization`. Mirrors the bearer-attaching
 * pattern in `gatekeeper-react/src/client/gatekeeper-client.ts` but
 * without the token transformer.
 */
const buildAppsClientLayer = (): Layer.Layer<AppsHttpApiClient, never, HttpClient.HttpClient> =>
  Layer.effect(AppsHttpApiClient, HttpApiClient.make(AppsApi, { baseUrl: '/' }))

/**
 * Build the admin `AppsAdminHttpApiClient` layer that reads the bearer
 * token from the {@link BearerToken} service on every request. The
 * `transformClient` closes over the Subscribable resolved at
 * layer-resolution time; `Subscribable.get` runs *per request*, so a
 * token rotation surfaces immediately — no layer rebuild, no client
 * rebuild. Canonical pattern: see
 * `gatekeeper-react/src/client/gatekeeper-client.ts`.
 */
const buildAppsAdminClientLayer = (): Layer.Layer<
  AppsAdminHttpApiClient,
  never,
  HttpClient.HttpClient | BearerToken
> =>
  Layer.effect(
    AppsAdminHttpApiClient,
    Effect.gen(function* () {
      const tokenSubscribable = yield* BearerToken
      return yield* HttpApiClient.make(AppsAdminApi, {
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

export {
  buildAppsAdminClientLayer,
  buildAppsClientLayer,
  type AppsAdminClientRequirements,
  type AppsClientRequirements,
}
