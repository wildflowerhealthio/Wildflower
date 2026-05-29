import type { HttpClient } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import { Layer, ManagedRuntime, type Effect, type Subscribable } from 'effect'
import { BearerToken } from 'kitchen-sink/auth-token'

// Session-scoped cache windows for the IN-MEMORY query client. These are
// deliberately measured in minutes, not days: nothing is persisted to
// disk, so there is no localStorage round-trip to keep entries alive for
// — the cache lives and dies with the page/WebView. `staleTime` keeps a
// freshly-read value authoritative long enough to make intra-session
// navigation instant; `gcTime` keeps an unused entry around long enough
// that bouncing between two screens doesn't refetch on every visit.
const FIVE_MINUTES_MS = 1000 * 60 * 5
const THIRTY_MINUTES_MS = 1000 * 60 * 30

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
 * IN-MEMORY client the React tree reads from) and a {@link RunAuthed}
 * `runAuthed` runner for executing authenticated slice effects from
 * inside a loader.
 */
interface RouterContext {
  readonly queryClient: QueryClient
  readonly runAuthed: RunAuthed
}

/**
 * Build the single IN-MEMORY {@link QueryClient} the app shares between
 * the React tree (via a plain `<QueryClientProvider>`) and the
 * {@link RouterContext} (via `createRouter({ context: { queryClient } })`),
 * so route `loader`s and component `useQuery` / `useMutation` calls all
 * read the same cache.
 *
 * This is the deliberate alternative to the localStorage-backed
 * `PersistQueryClientProvider` approach (PR #99): the maintainer decided
 * persisting PHI-adjacent query results to disk is undesirable, so the
 * cache stays purely in memory and is warmed by route PRELOADING
 * (`defaultPreload: 'intent'` + loader `ensureQueryData` + a small
 * startup prefetch) rather than restored from storage.
 *
 * Defaults shared by every screen in the app:
 *
 *   - `staleTime: 5m` — a value is considered fresh for five minutes, so
 *     navigating back to a screen within that window renders the cached
 *     value with no refetch. (Contrast with the persist approach's
 *     `staleTime: 0`, which refetched on every mount to revalidate the
 *     restored-from-disk snapshot — there's no stale disk snapshot to
 *     revalidate here.)
 *   - `gcTime: 30m` — keep an unused entry in cache for half an hour so a
 *     screen the user bounces away from and back to stays warm for the
 *     session. There is no persister to round-trip through, so this only
 *     governs in-memory retention.
 *   - `refetchOnWindowFocus: false` — the embedded WebView has no stable
 *     focus story (frequent host bridge re-renders trigger spurious focus
 *     events); refetch-on-focus would fire constantly there.
 */
const buildQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: FIVE_MINUTES_MS,
        gcTime: THIRTY_MINUTES_MS,
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
 * Effect runtime/layer plumbing directly. Co-located rather than placed
 * in `global/kitchen-sink` (home of `BearerToken`) because that package
 * does not depend on `@effect/platform`, so it can't name `HttpClient`.
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

export { buildQueryClient, buildRunAuthed, FIVE_MINUTES_MS, THIRTY_MINUTES_MS }
export type { RouterContext, RunAuthed }
