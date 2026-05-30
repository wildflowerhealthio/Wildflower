import type { QueryClient } from '@tanstack/react-query'

import { tunnelStateQueryOptions } from 'tunnel-react'
import type { RunAuthed } from '../router-context.ts'

/**
 * Warm key destinations once the `beforeLoad` auth gate has passed.
 * Each is an authed HTTP round-trip — keep the list small.
 *
 * No token-readiness guard anymore: the gate already `await`ed the
 * bearer before this runs (web had it synchronously, embedded waited
 * the bridge handshake), so every prefetch here is guaranteed a token.
 * Returns the settled `Promise` of every warm so the caller can emit
 * the embedded `UIReady` handshake once prefetches finish (success or
 * error — a warm failure must not block the WebView reveal).
 */
const prefetchKeyRoutes = (queryClient: QueryClient, runAuthed: RunAuthed): Promise<void> =>
  queryClient.prefetchQuery(tunnelStateQueryOptions(runAuthed))

export { prefetchKeyRoutes }
