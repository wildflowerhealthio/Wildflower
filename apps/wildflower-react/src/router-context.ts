import type { HttpClient } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import { AppsRouterContext } from 'apps-react'
import { CollectorRouterContext } from 'collector-react'
import { Duration, Effect, Layer, pipe, type Subscribable } from 'effect'
import { FhirR4ResourcesRouterContext } from 'fhir-r4-react'
import { GatekeeperRouterContext } from 'gatekeeper-react'
import { BearerToken } from 'kitchen-sink/auth-token'
import type { BaseRouterContext } from 'shared-structures-react'
import { TunnelRouterContext } from 'tunnel-react'

type RuntimeLayer = Layer.Layer<
  | Layer.Layer.Success<BaseRouterContext.RuntimeLayer>
  | Layer.Layer.Success<TunnelRouterContext.RuntimeLayer>
  | Layer.Layer.Success<AppsRouterContext.RuntimeLayer>
  | Layer.Layer.Success<GatekeeperRouterContext.RuntimeLayer>
  | Layer.Layer.Success<CollectorRouterContext.RuntimeLayer>
  | Layer.Layer.Success<FhirR4ResourcesRouterContext.RuntimeLayer>,
  never,
  never
>

/**
 * Run an authed Effect from a non-React call site (route loaders).
 * Supplies `BearerToken | HttpClient`; the caller still provides its
 * own slice client layer.
 */
type RunAuthed = <A, E>(
  effect: Effect.Effect<A, E, Layer.Layer.Success<RuntimeLayer>>
) => Promise<A>

interface RouterContext {
  readonly queryClient: QueryClient
  readonly runAuthed: RunAuthed
  readonly runtimeLayer: RuntimeLayer
  /**
   * Environment-specific auth-readiness wait, injected at `renderApp`
   * and consulted by the gated layouts' `beforeLoad`. Resolves when a
   * bearer token is present; rejects (tagged) otherwise. The gate owns
   * this, so an authed loader that runs is guaranteed a token.
   */
  readonly awaitAuthReady: BaseRouterContext.AwaitAuthReady
  /**
   * Resolves once the page-side `BridgeTransport` has flushed its
   * initial inbound queue and signalled the host to start sending.
   * For standalone web (`StubTransport`) this is `Promise.resolve()`.
   * For embedded, this gates the `_auth` `beforeLoad` so the bearer
   * token the host pushes over the gatekeeper bridge has had a chance
   * to arrive before `awaitAuthReady` reads `authTokenRef`.
   */
  readonly transportReady: Promise<void>
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
    Layer.provideMerge(httpClientLayer)
  )
  const runtimeLayer: RuntimeLayer = Layer.provideMerge(
    Layer.mergeAll(
      TunnelRouterContext.sliceRuntimeLayer,
      AppsRouterContext.sliceRuntimeLayer,
      GatekeeperRouterContext.sliceRuntimeLayer,
      CollectorRouterContext.sliceRuntimeLayer,
      FhirR4ResourcesRouterContext.sliceRuntimeLayer
    ),
    baseRuntimeLayer
  )
  return {
    runAuthed: (effect) => pipe(effect, Effect.provide(runtimeLayer), Effect.runPromise),
    runtimeLayer,
  }
}

export { buildQueryClient, buildRunAuthed }
export type { RouterContext, RunAuthed, RuntimeLayer }
