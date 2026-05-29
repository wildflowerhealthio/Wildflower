import type { QueryClient } from '@tanstack/react-query'
import { Effect } from 'effect'

import { authTokenRef } from 'gatekeeper-react'
import { tunnelStateQueryOptions } from 'tunnel-react'
import type { RunAuthed } from './router-context.ts'

/**
 * Eagerly warm the query cache for the small set of KEY destinations the
 * owner is most likely to hit first — the IN-MEMORY replacement for the
 * localStorage-restored snapshot the persist approach (PR #99) gave us.
 * Called once from `renderApp` (`app-root.tsx`) right after the router is
 * built.
 *
 * Today that set is exactly the tunnel state (`/settings/tunnel/`, the
 * worked-slice migration template, and a value the `/apps` landing also
 * reads), prefetched through the authed {@link RunAuthed} runner. It is
 * deliberately small: each prefetch is an authed HTTP round-trip, and
 * over-warming would fan out requests the user may never need. Add more
 * key routes here as their slices migrate onto `queryOptions` factories.
 *
 * @remarks
 * EMBEDDED TOKEN TIMING. In the embedded WebView the bearer token
 * arrives over the gatekeeper bridge (`AuthTokenIssued`) only AFTER
 * `transport.flushed`. An authed request fired before that would 401.
 * This prefetch is therefore gated on `authTokenRef` already holding a
 * token — true on standalone web (the token is read synchronously from
 * `localStorage` at module load) and false on embedded first paint
 * (where the in-component `useSuspenseQuery`, rendered only once the
 * `RequireAuth` gate sees the post-flush token, does the first read
 * instead). `prefetchQuery` swallows errors, but we skip rather than
 * rely on that so we never emit a doomed request.
 */
const prefetchKeyRoutes = (queryClient: QueryClient, runAuthed: RunAuthed): void => {
  const token = Effect.runSync(authTokenRef.get)
  if (token === null || token === '') return
  void queryClient.prefetchQuery(tunnelStateQueryOptions(runAuthed))
}

export { prefetchKeyRoutes }
