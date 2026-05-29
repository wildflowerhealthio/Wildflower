import { QueryClient } from '@tanstack/react-query'

const ONE_DAY_MS = 1000 * 60 * 60 * 24

/**
 * Typed context threaded through the TanStack Router tree.
 *
 * Registered on the root route via
 * `createRootRouteWithContext<RouterContext>()` (`src/routes/__root.tsx`)
 * and supplied to `createRouter({ context })` (`app-root.tsx`). Every
 * route `loader` / `beforeLoad` then receives a fully-typed
 * `context.queryClient`, so loaders can prefetch with
 * `context.queryClient.ensureQueryData(<queryOptions>)` against the same
 * client the React tree reads from.
 */
interface RouterContext {
  readonly queryClient: QueryClient
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

export { buildQueryClient, ONE_DAY_MS }
export type { RouterContext }
