import type { QueryClient } from '@tanstack/react-query'
import type { RunAuthed } from 'tunnel-react'

/**
 * The structural router-context shape the apps slice's routes depend on:
 * the shared in-memory `QueryClient` and the authed `RunAuthed` runner.
 *
 * Re-declared here — NOT imported from `apps/wildflower-react` — so the
 * slice stays decoupled from the app that hosts it (Issue #101). The
 * app's own `RouterContext`
 * (`apps/wildflower-react/src/bridges/router-context.ts`) is structurally
 * equal to this, so the apps route file type-checks both in the slice's
 * standalone route tree and when mounted under the app's
 * `createRootRouteWithContext<RouterContext>()` root.
 *
 * The apps landing reads tunnel state (`useTunnelStateQuery(runAuthed)`),
 * so it needs the same `runAuthed` runner the tunnel slice declares — we
 * reuse `tunnel-react`'s `RunAuthed` (a structural, app-free type) rather
 * than re-declaring it a third time.
 */
interface AppsRouterContext {
  readonly queryClient: QueryClient
  readonly runAuthed: RunAuthed
}

export type { AppsRouterContext }
