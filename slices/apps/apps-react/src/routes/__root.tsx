import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'

import type { AppsRouterContext } from '../router-context.ts'

/**
 * Standalone root for the apps slice's own file-based route tree, typed
 * with the structural {@link AppsRouterContext} so the slice's
 * `Route.useRouteContext()` calls (the apps landing reads the authed
 * `runAuthed` runner to drive `useTunnelStateQuery`) type-check IN
 * ISOLATION (`vp run --filter apps-react check`).
 *
 * The generator needs a `__root` to anchor `routeTree.gen.ts`. In
 * `apps/wildflower-react` the slice's `_auth/` directory is mounted under
 * the app's own `_auth` layout (typed with the structurally equal
 * `RouterContext`) via `@tanstack/virtual-file-routes`, so this root is
 * never used there — but the context SHAPE must match so the same route
 * file type-checks under both roots.
 */
export const Route = createRootRouteWithContext<AppsRouterContext>()({ component: Outlet })
