import { type UseSuspenseQueryOptions } from '@tanstack/react-query'
import { Effect } from 'effect'

import { authTokenRef } from './client/token-storage.ts'
import { type RouterContext } from './router-context.ts'

/**
 * Loader helper for authed gatekeeper routes. The `/settings` and `_auth`
 * gates are React *component* gates (`RequireAuth`), not `beforeLoad`, so
 * loaders fire before auth resolves. In embedded mode the bearer arrives
 * only after `transport.flushed`, so a prefetch on first paint would 401.
 *
 * Behaviour:
 *   - Token not ready yet (empty `authTokenRef`) → skip the prefetch and
 *     resolve immediately. The in-component `useSuspenseQuery` (rendered
 *     only after `RequireAuth` passes, i.e. post-flush) does the real
 *     read.
 *   - Token present → `ensureQueryData`, and let any genuine read failure
 *     (500 / schema-invalid / network) propagate so the route's
 *     `errorComponent` fires. **Never** swallow with a blanket `catch`.
 */
const ensureAuthedQuery = <TData, TKey extends readonly unknown[]>(
  context: Pick<RouterContext, 'queryClient'>,
  options: UseSuspenseQueryOptions<TData, Error, TData, TKey>
): Promise<TData | undefined> => {
  const token = Effect.runSync(authTokenRef.get)
  if (token === null || token === '') return Promise.resolve(undefined)
  return context.queryClient.ensureQueryData(options)
}

export { ensureAuthedQuery }
