import type { QueryClient } from '@tanstack/react-query'

import { authTokenRef } from 'gatekeeper-react'
import { webHttpClientLayer } from 'telemetry-react'
import { buildQueryClient, buildRunAuthed, type RunAuthed } from './router-context.ts'

/**
 * Build the per-entry query/runtime seam threaded into the TanStack
 * Router: the shared IN-MEMORY {@link QueryClient} and the long-lived
 * authed {@link RunAuthed} runner. Called once from `renderApp`
 * (`app-root.tsx`) per entry point.
 *
 * The runner provides `BearerToken` (from the page-lifetime `authTokenRef`
 * the React tree also reads through `<AuthTokenProvider>`) over the same
 * `webHttpClientLayer` every slice client uses. The HTTP transport is
 * UNIFORM across all three entries (`main-web`, `main-single-web`,
 * `main-embedded`) — the embedded bridge carries only messages, not HTTP
 * — so one layer is correct everywhere; there is no per-entry HTTP
 * switch. The runtime is app-scoped and lives for the page's lifetime
 * (`renderApp` has no teardown hook), which matches the page-lifetime
 * `authTokenRef` it closes over.
 *
 * Co-locating this wiring here keeps `app-root.tsx` focused on the React
 * tree and the Effect runtime/layer plumbing out of it.
 */
const buildAppQueryRuntime = (): {
  readonly queryClient: QueryClient
  readonly runAuthed: RunAuthed
} => {
  const queryClient = buildQueryClient()
  const { runAuthed } = buildRunAuthed(authTokenRef, webHttpClientLayer)
  return { queryClient, runAuthed }
}

export { buildAppQueryRuntime }
