import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'

import type { TunnelRouterContext } from '../router-context.ts'

/**
 * Standalone root for the tunnel slice's own file-based route tree,
 * typed with the structural {@link TunnelRouterContext} so the slice's
 * `loader` and `Route.useRouteContext()` calls type-check IN ISOLATION
 * (`vp run --filter tunnel-react check`).
 *
 * The generator needs a `__root` to anchor `routeTree.gen.ts`. In
 * `apps/wildflower-react` the slice's `settings/` directory is mounted
 * under the app's own root (which is typed with the app's structurally
 * compatible `RouterContext`) via `@tanstack/virtual-file-routes`, so
 * this root is never used there — but the context SHAPE must match so
 * the same route file type-checks under both roots.
 */
export const Route = createRootRouteWithContext<TunnelRouterContext>()({ component: Outlet })
