import type { QueryClient } from '@tanstack/react-query'
import { Effect } from 'effect'

import { authTokenRef } from 'gatekeeper-react'
import { tunnelStateQueryOptions } from 'tunnel-react'
import type { RunAuthed } from '../router-context.ts'

/**
 * Warm key destinations once at startup. Each is an authed HTTP
 * round-trip — keep the list small.
 *
 * Skipped when `authTokenRef` is empty: embedded WebView gets its token
 * over the gatekeeper bridge only after `transport.flushed`, so a
 * prefetch on first paint would 401. The in-component
 * `useSuspenseQuery` (rendered after `RequireAuth`) handles that case.
 */
const prefetchKeyRoutes = (queryClient: QueryClient, runAuthed: RunAuthed): void => {
  const token = Effect.runSync(authTokenRef.get)
  if (token === null || token === '') return
  void queryClient.prefetchQuery(tunnelStateQueryOptions(runAuthed))
}

export { prefetchKeyRoutes }
