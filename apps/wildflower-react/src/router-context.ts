import { FetchHttpClient, type HttpClient, HttpClientError } from '@effect/platform'
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { AppsRouterContext } from 'apps-react'
import { CollectorRouterContext } from 'collector-react'
import { DatabasesRouterContext } from 'databases-react'
import { Duration, Effect, Layer, pipe, Schedule } from 'effect'
import { FhirR4ResourcesRouterContext } from 'fhir-r4-react'
import { GatekeeperRouterContext, unwrapFiberFailure } from 'gatekeeper-react'
import type { BaseRouterContext } from 'shared-structures-react'
import { TunnelRouterContext } from 'tunnel-react'

import { webTelemetryLayerFromEnv } from 'telemetry-web'
import type { ReactTransport } from './bridges/transport-context.ts'

type SliceServices =
  | Layer.Layer.Success<TunnelRouterContext.RuntimeLayer>
  | Layer.Layer.Success<AppsRouterContext.RuntimeLayer>
  | Layer.Layer.Success<GatekeeperRouterContext.RuntimeLayer>
  | Layer.Layer.Success<CollectorRouterContext.RuntimeLayer>
  | Layer.Layer.Success<FhirR4ResourcesRouterContext.RuntimeLayer>
  | Layer.Layer.Success<DatabasesRouterContext.RuntimeLayer>

type RuntimeLayer = BaseRouterContext.RuntimeLayerWith<SliceServices>
type RunAuthed = BaseRouterContext.RunAuthedWith<SliceServices>

interface RouterContext extends BaseRouterContext.RouterContextWith<SliceServices> {
  /**
   * Resolves to the page-side `BridgeTransport` (narrowed to the React
   * surface — only `sendMessage`) once the boot-time `signalReady`
   * finishes. The `_auth` route loader awaits this
   * before emitting the embedded `UIReady` handshake; by the time the
   * loader runs the `beforeLoad` gate's `awaitAuthReady` has already
   * resolved (which on embedded already waited the same promise), so
   * the await is a microtask on every path that reaches here.
   */
  readonly transport: Promise<ReactTransport>
  /**
   * Absolute API origin, set only when the page is not served by the API
   * server (the Tauri webview loads from the dev server / asset protocol while
   * the API lives on the host's loopback origin) — the same value passed to
   * {@link buildAppQueryRuntime}. Threaded into context so the apps launch
   * POST can target the host server rather than the page origin. Omitted on
   * web/embedded, where the page IS the API origin.
   */
  readonly apiBaseUrl?: string
  /**
   * The host's granted-scope string (e.g. `system/*.cruds wildflower/*.cruds`),
   * sourced from the Tauri shell's `tauri-shared-config.json`. Read by the
   * gatekeeper slice's `NeedsAuthMessage` so the WebView's device-login request
   * asks for exactly the scopes gatekeeper-rust seeds. Omitted on web/embedded.
   */
  readonly localGrantedScopes?: string
}

/**
 * Cross-origin cookie-auth `RequestInit` for the platform `fetch`. On Tauri the
 * page origin (`tauri://localhost` in a build, the dev server in dev) is
 * cross-site to the loopback API origin (`http://127.0.0.1:<port>`), so the
 * host-planted `wf_auth` cookie only rides fetches made in credentialed mode.
 * `FetchHttpClient` reads this tag from the **request-time** fiber context (not
 * at layer build), so it's merged into the runtime layer below as an extra
 * service — the same way the telemetry services already ride along. Same-origin
 * web/embedded already send the cookie; `credentials: 'include'` is a superset,
 * so this is inert there.
 */
const credentialedFetchLayer = Layer.succeed(FetchHttpClient.RequestInit, {
  credentials: 'include',
})

/** TanStack Query's own default retry count, preserved for non-401 errors. */
const DEFAULT_QUERY_RETRIES = 3

/** How many times an authed request that comes back 401 is re-sent. */
const UNAUTHORIZED_RETRY_TIMES = 3

/** Spacing between those re-sends — long enough for a just-planted cookie to
 * land in the webview's jar, short enough to be invisible on a warm boot. */
const UNAUTHORIZED_RETRY_SPACING = Duration.millis(150)

/**
 * A 401 surfaces as an `HttpClientError.ResponseError`: `HttpApiClient` maps an
 * undeclared status through its `statusOrElse`, and a raw `filterStatusOk` maps
 * any non-2xx — both to a `ResponseError` carrying the response. So the status,
 * not the reason, is the reliable 401 signal.
 */
const isUnauthorizedResponseError = (error: unknown): boolean =>
  error instanceof HttpClientError.ResponseError && error.response.status === 401

/**
 * The same test against the value a rejected `runAuthed` (i.e. a TanStack Query
 * `queryFn`/mutation) surfaces: `Effect.runPromise` rejects with a
 * `FiberFailure` wrapping the cause, so unwrap it to the underlying
 * `ResponseError` first. Used by both the QueryCache redirect and the
 * skip-retry-on-401 policy below.
 */
const isUnauthorizedFailure = (error: unknown): boolean =>
  isUnauthorizedResponseError(unwrapFiberFailure(error))

/**
 * Retry policy for the cookie-plant boot race: re-send only on a 401,
 * {@link UNAUTHORIZED_RETRY_TIMES} times, {@link UNAUTHORIZED_RETRY_SPACING}
 * apart. `whileInput` gates on the 401 test so any other failure propagates on
 * the first attempt instead of being pointlessly re-sent.
 */
const unauthorizedRetrySchedule = Schedule.intersect(
  Schedule.recurs(UNAUTHORIZED_RETRY_TIMES),
  Schedule.spaced(UNAUTHORIZED_RETRY_SPACING)
).pipe(Schedule.whileInput(isUnauthorizedResponseError))

/**
 * In-memory only — no persister (PHI-adjacent). Warmed by route
 * preloading, not storage restore.
 *
 * `refetchOnWindowFocus: false` because the embedded WebView fires
 * spurious focus events on host bridge re-renders.
 *
 * `onUnauthorized` fires when an authed query or mutation ends in a 401 that
 * survived the boot-race retry (see {@link buildRunAuthed}) — i.e. the session
 * is genuinely gone, so the caller sends the user to device login. The
 * QueryCache/MutationCache `onError` hooks fire once the query/mutation reaches
 * its error state (after TanStack's own retries), so the redirect isn't
 * re-fired per attempt. `retry` then skips TanStack's own backoff for a 401 —
 * `runAuthed` already spent the boot-race budget, so piling exponential retries
 * on top would only delay the redirect; other errors keep the default count.
 */
const buildQueryClient = (onUnauthorized: () => void): QueryClient => {
  const redirectIfUnauthorized = (error: unknown): void => {
    if (isUnauthorizedFailure(error)) onUnauthorized()
  }
  return new QueryClient({
    queryCache: new QueryCache({ onError: redirectIfUnauthorized }),
    mutationCache: new MutationCache({ onError: redirectIfUnauthorized }),
    defaultOptions: {
      queries: {
        staleTime: pipe(5, Duration.minutes, Duration.toMillis),
        gcTime: pipe(30, Duration.minutes, Duration.toMillis),
        refetchOnWindowFocus: false,
        retry: (failureCount, error) =>
          !isUnauthorizedFailure(error) && failureCount < DEFAULT_QUERY_RETRIES,
      },
    },
  })
}

/**
 * Builds the page-lifetime runtime layer + authed runner. Clients are
 * tokenless — auth rides the `HttpOnly` `wf_auth` cookie that the
 * platform `fetch` sends with same-origin requests.
 *
 * The `beforeLoad` auth gate (not the loaders) guarantees the auth
 * signal is ready before any authed loader runs, so there's no
 * `isTokenReady` reader here — loaders are plain `ensureQueryData`.
 */
const buildRunAuthed = (
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>
): {
  readonly runAuthed: RunAuthed
  readonly runtimeLayer: RuntimeLayer
} => {
  const baseRuntimeLayer = Layer.mergeAll(
    httpClientLayer,
    webTelemetryLayerFromEnv(),
    credentialedFetchLayer
  )
  const runtimeLayer: RuntimeLayer = Layer.provideMerge(
    Layer.mergeAll(
      TunnelRouterContext.sliceRuntimeLayer,
      AppsRouterContext.sliceRuntimeLayer,
      GatekeeperRouterContext.sliceRuntimeLayer,
      CollectorRouterContext.sliceRuntimeLayer,
      FhirR4ResourcesRouterContext.sliceRuntimeLayer,
      DatabasesRouterContext.sliceRuntimeLayer
    ),
    baseRuntimeLayer
  )
  return {
    // The boot-race retry sits *inside* the runner (before `provide`, so each
    // re-send re-runs the request within the same built runtime), scoped to the
    // cookie-authed surface: the device-login flow runs its own effects through
    // `useGatekeeperRuntimeLayer`, not `runAuthed`, so its expected 401/400
    // polling responses are untouched. A persistent 401 propagates unchanged so
    // the QueryCache `onError` can redirect to device login.
    runAuthed: (effect, options) =>
      pipe(
        effect,
        Effect.retry(unauthorizedRetrySchedule),
        Effect.provide(runtimeLayer),
        (provided) => Effect.runPromise(provided, options)
      ),
    runtimeLayer,
  }
}

export {
  buildQueryClient,
  buildRunAuthed,
  isUnauthorizedFailure,
  isUnauthorizedResponseError,
  unauthorizedRetrySchedule,
}
export type { RouterContext, RunAuthed, RuntimeLayer }
