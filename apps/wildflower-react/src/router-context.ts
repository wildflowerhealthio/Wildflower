import type { HttpClient } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import { AppsRouterContext } from 'apps-react'
import { Duration, Effect, Layer, pipe, type Subscribable } from 'effect'
import { BearerToken } from 'kitchen-sink/auth-token'
import type { BaseRouterContext } from 'shared-structures-react'
import { TunnelRouterContext } from 'tunnel-react'

type RuntimeLayer = Layer.Layer<
  | Layer.Layer.Success<BaseRouterContext.RuntimeLayer>
  | Layer.Layer.Success<TunnelRouterContext.RuntimeLayer>
  | Layer.Layer.Success<AppsRouterContext.RuntimeLayer>,
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
    Layer.mergeAll(TunnelRouterContext.sliceRuntimeLayer, AppsRouterContext.sliceRuntimeLayer),
    baseRuntimeLayer
  )
  return {
    runAuthed: (effect) => pipe(effect, Effect.provide(runtimeLayer), Effect.runPromise),
    runtimeLayer,
  }
}

export { buildQueryClient, buildRunAuthed }
export type { RouterContext, RunAuthed, RuntimeLayer }
