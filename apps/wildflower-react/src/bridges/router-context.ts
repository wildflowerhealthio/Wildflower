import type { HttpClient } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import { Layer, ManagedRuntime, type Effect, type Subscribable } from 'effect'
import { BearerToken } from 'kitchen-sink/auth-token'

const ONE_DAY_MS = 1000 * 60 * 60 * 24

/**
 * Run an authenticated Effect from a route `loader` (or any other
 * non-React callsite that holds the {@link RouterContext}).
 *
 * Loaders run OUTSIDE the React tree, so they can't reach the
 * React-provided bearer token or the React-composed slice client layers.
 * `runAuthed` closes over the app's long-lived authed runtime — the one
 * built in `app-root.tsx` from `Layer.succeed(BearerToken, authTokenRef)`
 * merged over the web `HttpClient` layer — and supplies exactly that
 * shared environment (`BearerToken` + `HttpClient.HttpClient`) to the
 * effect it's handed.
 *
 * The caller still provides its OWN slice client layer (which is what
 * leaves `BearerToken` + `HttpClient` unprovided), so no product slice
 * has to know about any other. A tunnel loader, for example, runs:
 *
 * ```ts
 * context.runAuthed(
 *   Effect.flatMap(TunnelAdminHttpApiClient, (c) => c.tunnel.GetTunnel()).pipe(
 *     Effect.provide(buildTunnelAdminClientLayer())
 *   )
 * )
 * ```
 *
 * `buildTunnelAdminClientLayer()` requires `BearerToken | HttpClient`,
 * which is precisely what `runAuthed` provides — no `any`, no casts.
 */
type RunAuthed = <A, E>(
  effect: Effect.Effect<A, E, BearerToken | HttpClient.HttpClient>
) => Promise<A>

/**
 * Typed context threaded through the TanStack Router tree.
 *
 * Registered on the root route via
 * `createRootRouteWithContext<RouterContext>()` (`src/routes/__root.tsx`)
 * and supplied to `createRouter({ context })` (`app-root.tsx`). Every
 * route `loader` / `beforeLoad` then receives a fully-typed
 * `context.queryClient` (prefetch with
 * `context.queryClient.ensureQueryData(<queryOptions>)` against the same
 * client the React tree reads from) and a {@link RunAuthed} `runAuthed`
 * runner for executing authenticated slice effects from inside a loader.
 */
interface RouterContext {
  readonly queryClient: QueryClient
  readonly runAuthed: RunAuthed
}

/**
 * Build the single {@link QueryClient} the app shares between the React
 * tree (via `QueryClientPersistProvider`) and the {@link RouterContext}
 * (via `createRouter({ context: { queryClient } })`), so route `loader`s
 * and component `useQuery` / `useMutation` calls all read the same cache.
 *
 * Defaults shared by every screen in the app:
 *
 *   - `staleTime: 0` — every query is stale on mount, so the very next
 *     render after the persister hydrates from localStorage kicks off a
 *     background refetch. The cached value renders immediately; the
 *     fresh value swaps in once it returns.
 *   - `gcTime: 24h` — keep queries in cache long enough for the
 *     persister to round-trip them through localStorage between
 *     sessions. Without this, queries would be garbage-collected after
 *     5 minutes of being unused and the persister would have nothing to
 *     write.
 *   - `refetchOnWindowFocus: false` — the embedded WebView has no
 *     stable focus story (frequent host bridge re-renders trigger
 *     spurious focus events); the on-mount refetch already gives us
 *     stale-while-revalidate.
 *
 * @remarks
 * Created once per entry point in `renderApp` (`app-root.tsx`) and passed
 * down both to `QueryClientPersistProvider` and `createRouter`. Keeping
 * construction outside React (rather than in a `useState` initializer) is
 * what lets the same instance reach the router context, which is
 * assembled before the React tree mounts. Lives here — beside the context
 * type, in a `.ts` (non-component) module — so the React-Fast-Refresh
 * lint rule that forbids mixing component and non-component exports stays
 * satisfied.
 */
const buildQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 0,
        gcTime: ONE_DAY_MS,
        refetchOnWindowFocus: false,
      },
    },
  })

/**
 * Build the app's long-lived authed runner — a {@link RunAuthed} backed
 * by a {@link ManagedRuntime} that provides `BearerToken` (from the
 * supplied live token `Subscribable`) over the supplied `HttpClient`
 * layer.
 *
 * Called once per entry point in `renderApp` (`app-root.tsx`) with the
 * page-lifetime `authTokenRef` and the same `webHttpClientLayer` every
 * slice client uses; the returned runner is threaded into
 * `createRouter`'s {@link RouterContext} so loaders can run authenticated
 * slice effects. Co-located here, beside the {@link RunAuthed} type and
 * {@link buildQueryClient}, so the whole router-context recipe lives in
 * one non-component module — and so `app-root.tsx` need not import the
 * Effect runtime/layer plumbing directly.
 *
 * `tokenSubscribable.get` runs per request inside each slice client's
 * `transformClient`, so a token rotation surfaces without rebuilding the
 * runtime. The merged layer has no remaining requirements
 * (`Layer<BearerToken | HttpClient, never, never>`), which is what
 * `ManagedRuntime.make` requires.
 *
 * Returns the runner plus the runtime's `dispose`; the app keeps the
 * runtime for the page's lifetime (no `renderApp` teardown hook), but the
 * disposer is surfaced for tests and any future teardown path.
 */
const buildRunAuthed = (
  tokenSubscribable: Subscribable.Subscribable<string | null>,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>
): { readonly runAuthed: RunAuthed; readonly dispose: () => Promise<void> } => {
  const runtime = ManagedRuntime.make(
    Layer.succeed(BearerToken, tokenSubscribable).pipe(Layer.provideMerge(httpClientLayer))
  )
  return {
    runAuthed: (effect) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  }
}

export { buildQueryClient, buildRunAuthed, ONE_DAY_MS }
export type { RouterContext, RunAuthed }
