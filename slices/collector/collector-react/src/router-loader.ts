import { type UseSuspenseQueryOptions } from '@tanstack/react-query'

import { type RouterContext } from './router-context.ts'

/**
 * Loader helper for authed collector routes. The `_auth` gate is a React
 * *component* gate (`RequireAuth`), not `beforeLoad`, so loaders fire
 * before auth resolves. In embedded mode the bearer arrives only after
 * `transport.flushed`, so a prefetch on first paint would 401.
 *
 * Behaviour:
 *   - Token not ready yet (`context.isTokenReady()` false) → skip the
 *     prefetch and resolve immediately. The in-component
 *     `useSuspenseQuery` (rendered only after `RequireAuth` passes, i.e.
 *     post-flush) does the real read.
 *   - Token present → `ensureQueryData`, and let any genuine read failure
 *     (500 / schema-invalid / network) propagate so the route's
 *     `errorComponent` fires. **Never** swallow with a blanket `catch`.
 *
 * The readiness check reads through `context.isTokenReady` — the single
 * reader hoisted onto `BaseRouterContext` and shared with the app's
 * `prefetchKeyRoutes` — rather than reading `authTokenRef` directly, so
 * there is one source of truth for "is the bearer ready" (matching the
 * gatekeeper loader's guard from #112).
 */
const ensureAuthedQuery = <TData, TKey extends readonly unknown[]>(
  context: Pick<RouterContext, 'queryClient' | 'isTokenReady'>,
  options: UseSuspenseQueryOptions<TData, Error, TData, TKey>
): Promise<TData | undefined> => {
  if (!context.isTokenReady()) return Promise.resolve(undefined)
  return context.queryClient.ensureQueryData(options)
}

export { ensureAuthedQuery }
