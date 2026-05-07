/**
 * Layer-construction shared by every gatekeeper-react HTTP session
 * (authenticated and unauthenticated). Centralising here means the
 * runtime context — `HttpClient.HttpClient` for sibling-API calls,
 * `GatekeeperHttpApiClient` for typed gatekeeper API access — is wired
 * exactly once for the whole web bundle.
 */

import { FetchHttpClient, HttpApiClient, HttpClient, HttpClientRequest } from '@effect/platform'
import type { ManagedRuntime } from 'effect'
import { Layer } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { GatekeeperApi } from 'gatekeeper-core/http-api-definition'
import { webTelemetryLayerFromEnv } from 'telemetry-web'

type SessionEnv = HttpClient.HttpClient | GatekeeperHttpApiClient
type SessionRuntime = ManagedRuntime.ManagedRuntime<SessionEnv, never>

/**
 * Authentication header transform shared by the gatekeeper client
 * and any sibling-API client built off the same session.
 */
const setBearerToken =
  (token: string) =>
  (c: HttpClient.HttpClient): HttpClient.HttpClient =>
    HttpClient.mapRequest(c, (request) =>
      HttpClientRequest.setHeader(request, 'Authorization', `Bearer ${token}`)
    )

const httpLayer: Layer.Layer<HttpClient.HttpClient> = Layer.mergeAll(
  FetchHttpClient.layer,
  webTelemetryLayerFromEnv()
).pipe(Layer.provideMerge(FetchHttpClient.layer))

/**
 * Build the `GatekeeperHttpApiClient` service backed by `HttpApiClient.make`
 * — with a bearer header when `token` is provided, plain otherwise.
 * Provided downstream of `httpLayer` so the resulting layer's only
 * unsatisfied requirement at the runtime boundary is `never`.
 */
const buildGatekeeperClientLayer = (
  token: string | null
): Layer.Layer<GatekeeperHttpApiClient, never, HttpClient.HttpClient> => {
  const baseOptions = { baseUrl: '/' }
  const options =
    token === null ? baseOptions : { ...baseOptions, transformClient: setBearerToken(token) } // oxlint-disable-line eslint/no-ternary -- two-arm config object selection
  return Layer.effect(GatekeeperHttpApiClient, HttpApiClient.make(GatekeeperApi, options))
}

const buildSessionLayer = (token: string | null): Layer.Layer<SessionEnv> =>
  Layer.merge(httpLayer, buildGatekeeperClientLayer(token).pipe(Layer.provide(httpLayer)))

export { buildSessionLayer, setBearerToken, type SessionEnv, type SessionRuntime }
