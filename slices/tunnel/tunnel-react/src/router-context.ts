import type { QueryClient } from '@tanstack/react-query'

import type { RunAuthed } from './queries.ts'

/**
 * The structural router-context shape the tunnel slice's routes depend
 * on: the shared in-memory `QueryClient` (for loader `ensureQueryData`)
 * and the authed {@link RunAuthed} runner (for the tunnel admin effects).
 *
 * Re-declared here — NOT imported from `apps/wildflower-react` — so the
 * slice stays decoupled from the app that hosts it (Issue #101). The
 * app's own `RouterContext`
 * (`apps/wildflower-react/src/bridges/router-context.ts`) is structurally
 * a superset/equal of this, so the tunnel route file type-checks both in
 * the slice's standalone route tree and when mounted under the app's
 * `createRootRouteWithContext<RouterContext>()` root.
 */
interface TunnelRouterContext {
  readonly queryClient: QueryClient
  readonly runAuthed: RunAuthed
}

export type { TunnelRouterContext }
