import type { HttpClient } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import { AppsRouterContext } from 'apps-react'
import { Duration, Effect, Layer, pipe, type Subscribable } from 'effect'
import { GatekeeperRouterContext } from 'gatekeeper-react'
import { BearerToken } from 'kitchen-sink/auth-token'
import type { BaseRouterContext } from 'shared-structures-react'
import { TunnelRouterContext } from 'tunnel-react'

type RuntimeLayer = Layer.Layer<
  | Layer.Layer.Success<BaseRouterContext.RuntimeLayer>
  | Layer.Layer.Success<TunnelRouterContext.RuntimeLayer>
  | Layer.Layer.Success<AppsRouterContext.RuntimeLayer>
  | Layer.Layer.Success<GatekeeperRouterContext.RuntimeLayer>,
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
   * Whether the bearer token is available yet. Authed route loaders
   * consult this to skip a first-paint prefetch that would 401 on the
   * embedded WebView (token arrives over the gatekeeper bridge only
   * after `transport.flushed`). Standalone web has the token
   * synchronously from localStorage, so this is `true` immediately and
   * loaders warm the cache for first paint.
   */
  readonly isTokenReady: () => boolean
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
 * `isTokenReady` reads the same `Subscribable` synchronously so authed
 * loaders can gate a first-paint prefetch on the token being present —
 * a non-empty string means standalone web (localStorage) or a
 * post-flush embedded session; `null`/`''` means the embedded bridge
 * hasn't delivered the token yet.
 */
const buildRunAuthed = (
  tokenSubscribable: Subscribable.Subscribable<string | null>,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>
): {
  readonly runAuthed: RunAuthed
  readonly runtimeLayer: RuntimeLayer
  readonly isTokenReady: () => boolean
} => {
  const baseRuntimeLayer = Layer.succeed(BearerToken, tokenSubscribable).pipe(
    Layer.provideMerge(httpClientLayer)
  )
  const runtimeLayer: RuntimeLayer = Layer.provideMerge(
    Layer.mergeAll(
      TunnelRouterContext.sliceRuntimeLayer,
      AppsRouterContext.sliceRuntimeLayer,
      GatekeeperRouterContext.sliceRuntimeLayer
    ),
    baseRuntimeLayer
  )
  return {
    runAuthed: (effect) => pipe(effect, Effect.provide(runtimeLayer), Effect.runPromise),
    runtimeLayer,
    isTokenReady: () => {
      const token = Effect.runSync(tokenSubscribable.get)
      return token !== null && token !== ''
    },
  }
}

export { buildQueryClient, buildRunAuthed }
export type { RouterContext, RunAuthed, RuntimeLayer }
