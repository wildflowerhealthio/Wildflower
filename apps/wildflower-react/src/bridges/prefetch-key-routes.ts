import type { QueryClient } from '@tanstack/react-query'

import { tunnelStateQueryOptions } from 'tunnel-react'
import type { RouterContext, RunAuthed } from '../router-context.ts'

/**
 * Warm key destinations once at startup. Each is an authed HTTP
 * round-trip — keep the list small.
 *
 * Skipped when the token isn't ready: embedded WebView gets its token
 * over the gatekeeper bridge only after `transport.flushed`, so a
 * prefetch on first paint would 401. The in-component
 * `useSuspenseQuery` (rendered after `RequireAuth`) handles that case.
 *
 * Readiness is read through `isTokenReady` from the router context — the
 * single reader hoisted onto `BaseRouterContext` and shared with
 * gatekeeper's `ensureAuthedQuery` loader — so the app and the slice
 * loaders agree on one source of truth for "is the bearer ready."
 */
const prefetchKeyRoutes = (
  queryClient: QueryClient,
  runAuthed: RunAuthed,
  isTokenReady: RouterContext['isTokenReady']
): void => {
  if (!isTokenReady()) return
  void queryClient.prefetchQuery(tunnelStateQueryOptions(runAuthed))
}

export { prefetchKeyRoutes }
