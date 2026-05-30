import { type UseSuspenseQueryOptions } from '@tanstack/react-query'

import { type RouterContext } from './router-context.ts'

/**
 * Loader helper for authed gatekeeper routes. The `_auth` and
 * `/settings` layouts now gate on a `beforeLoad` that `await`s the
 * bearer token, so by the time this loader runs the token is
 * guaranteed present — embedded waited the bridge handshake, web had it
 * synchronously. No more first-paint skip; this is a plain
 * `ensureQueryData`.
 *
 * Any genuine read failure (500 / schema-invalid / network) propagates
 * so the route's `errorComponent` fires. **Never** swallow with a
 * blanket `catch`.
 */
const ensureAuthedQuery = <TData, TKey extends readonly unknown[]>(
  context: Pick<RouterContext, 'queryClient'>,
  options: UseSuspenseQueryOptions<TData, Error, TData, TKey>
): Promise<TData> => context.queryClient.ensureQueryData(options)

export { ensureAuthedQuery }
