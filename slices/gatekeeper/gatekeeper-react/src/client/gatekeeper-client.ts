import { FetchHttpClient, HttpApiClient, HttpClient, HttpClientRequest } from '@effect/platform'
import { Layer, ManagedRuntime } from 'effect'
import type { Effect } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { GatekeeperApi } from 'gatekeeper-core/http-api-definition'
import { webTelemetryLayerFromEnv } from 'telemetry-web'

type GatekeeperClientEnv = HttpClient.HttpClient | GatekeeperHttpApiClient
type GatekeeperClientRuntime = ManagedRuntime.ManagedRuntime<GatekeeperClientEnv, never>

/**
 * Per-side handle to the resolved `GatekeeperHttpApiClient`. The
 * `runtime` carries the `HttpClient` + `GatekeeperHttpApiClient` Layers
 * pre-wired, so callers can `runPromise` Effects that flatMap the tag
 * without re-supplying Layers each call.
 *
 * `token` is `null` for the unauthenticated provider (covers public
 * routes like OAuth polling and the device-flow sign-in flow); a
 * non-empty string for the authenticated provider mounted by
 * `<AuthorizedAppShell>` in the app.
 */
interface GatekeeperClient {
  readonly token: string | null
  readonly runtime: GatekeeperClientRuntime
  readonly runPromise: <A, E>(eff: Effect.Effect<A, E, GatekeeperClientEnv>) => Promise<A>
}

/** Sets `Authorization: Bearer <token>` on every request. */
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

/** Build a `GatekeeperHttpApiClient` layer; attaches a bearer header when `token` is non-null. */
const buildGatekeeperClientLayer = (
  token: string | null
): Layer.Layer<GatekeeperHttpApiClient, never, HttpClient.HttpClient> => {
  const baseOptions = { baseUrl: '/' }
  const options =
    token === null ? baseOptions : { ...baseOptions, transformClient: setBearerToken(token) } // oxlint-disable-line eslint/no-ternary -- two-arm config object selection
  return Layer.effect(GatekeeperHttpApiClient, HttpApiClient.make(GatekeeperApi, options))
}

const buildGatekeeperRuntimeLayer = (token: string | null): Layer.Layer<GatekeeperClientEnv> =>
  Layer.merge(httpLayer, buildGatekeeperClientLayer(token).pipe(Layer.provide(httpLayer)))

/**
 * Build a {@link GatekeeperClient} for the given token. `null` produces
 * an unauthenticated client suitable for public endpoints (OAuth device
 * flow, polling). A non-null token attaches `Authorization: Bearer …` to
 * every request.
 *
 * Each call mints a fresh `ManagedRuntime`; the React provider memoises on
 * `token` so a token rotation boots a new runtime and disposes the old one.
 */
const makeGatekeeperClient = (token: string | null): GatekeeperClient => {
  const runtime: GatekeeperClientRuntime = ManagedRuntime.make(buildGatekeeperRuntimeLayer(token))
  return {
    token,
    runtime,
    runPromise: (eff) => runtime.runPromise(eff),
  }
}

export {
  buildGatekeeperClientLayer,
  makeGatekeeperClient,
  setBearerToken,
  type GatekeeperClient,
  type GatekeeperClientEnv,
  type GatekeeperClientRuntime,
}
