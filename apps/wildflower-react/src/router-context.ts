import type { HttpClient } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import { AppsRouterContext } from 'apps-react'
import { CollectorRouterContext } from 'collector-react'
import { DatabasesRouterContext } from 'databases-react'
import { Duration, Effect, Layer, pipe, type Subscribable } from 'effect'
import { FhirR4ResourcesRouterContext } from 'fhir-r4-react'
import { GatekeeperRouterContext } from 'gatekeeper-react'
import { BearerToken } from 'kitchen-sink/auth-token'
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
   * Absolute API origin for entries whose page is not served by the API
   * server (the Tauri webview loads from the dev server / asset protocol
   * while the API lives on the host's loopback origin) — the same value
   * passed to {@link buildAppQueryRuntime}. Threaded into context so the
   * apps launch POST can target `${apiBaseUrl}/apps/{id}` (the host server)
   * rather than the page origin. Omitted on web/embedded, where the page IS
   * served by the API and a same-origin relative path suffices.
   */
  readonly apiBaseUrl?: string
}

/**
 * In-memory only — no persister (PHI-adjacent). Warmed by route
 * preloading, not storage restore.
 *
 * `refetchOnWindowFocus: false` because the embedded WebView fires
 * spurious focus events on host bridge re-renders.
 */
const buildQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: pipe(5, Duration.minutes, Duration.toMillis),
        gcTime: pipe(30, Duration.minutes, Duration.toMillis),
        refetchOnWindowFocus: false,
      },
    },
  })

/**
 * `BearerToken` reads through the live `Subscribable` per request, so
 * token rotation surfaces without rebuilding the runtime. `dispose` is
 * for tests; the app keeps the runtime for the page's lifetime.
 *
 * The `beforeLoad` auth gate (not the loaders) now guarantees a token
 * before any authed loader runs, so there's no `isTokenReady` reader
 * here anymore — loaders are plain `ensureQueryData` again.
 */
const buildRunAuthed = (
  tokenSubscribable: Subscribable.Subscribable<string | null>,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>
): {
  readonly runAuthed: RunAuthed
  readonly runtimeLayer: RuntimeLayer
} => {
  const baseRuntimeLayer = Layer.succeed(BearerToken, tokenSubscribable).pipe(
    Layer.provideMerge(Layer.merge(httpClientLayer, webTelemetryLayerFromEnv()))
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
    runAuthed: (effect, options) =>
      pipe(effect, Effect.provide(runtimeLayer), (provided) =>
        Effect.runPromise(provided, options)
      ),
    runtimeLayer,
  }
}

export { buildQueryClient, buildRunAuthed }
export type { RouterContext, RunAuthed, RuntimeLayer }
