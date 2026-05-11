import { HttpApiClient, HttpClient, HttpClientRequest } from '@effect/platform'
import { Layer } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { GatekeeperApi } from 'gatekeeper-core/http-api-definition'

/**
 * Union of services a `GatekeeperHttpApiClient` consumer needs in
 * context: the `GatekeeperHttpApiClient` itself plus an `HttpClient`
 * (which the slice's layer leaves unprovided so apps can share one
 * `HttpClient` across every slice's client layer).
 */
type GatekeeperClientRequirements = HttpClient.HttpClient | GatekeeperHttpApiClient

/**
 * Returns a function that maps an `HttpClient` to a new one that
 * attaches `Authorization: Bearer <token>` on every request.
 * Intended to be passed to `HttpApiClient.make`'s `transformClient`
 * option (or any other client-modifying API).
 */
const makeBearerTokenClientTransformer =
  (token: string) =>
  (c: HttpClient.HttpClient): HttpClient.HttpClient =>
    HttpClient.mapRequest(c, (request) =>
      HttpClientRequest.setHeader(request, 'Authorization', `Bearer ${token}`)
    )

/**
 * Build a `GatekeeperHttpApiClient` layer. Attaches a bearer header
 * when `token` is non-null. The resulting layer requires an
 * `HttpClient` — apps compose this with other slices' client layers
 * and provide a single shared `HttpClient` once.
 *
 * `<GatekeeperClientProvider token>` puts this layer in context; the
 * app composes via `useAllClientsLayer()`.
 */
const buildGatekeeperClientLayer = (
  token: string | null
): Layer.Layer<GatekeeperHttpApiClient, never, HttpClient.HttpClient> => {
  const transformClient = token === null ? undefined : makeBearerTokenClientTransformer(token) // oxlint-disable-line eslint/no-ternary -- two-arm config selection
  return Layer.effect(
    GatekeeperHttpApiClient,
    HttpApiClient.make(GatekeeperApi, { baseUrl: '/', transformClient })
  )
}

export {
  buildGatekeeperClientLayer,
  makeBearerTokenClientTransformer,
  type GatekeeperClientRequirements,
}
