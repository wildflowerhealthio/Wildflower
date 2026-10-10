import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'

import type { RouterContext } from '../router-context.ts'

/**
 * Standalone root anchoring the slice's own `routeTree.gen.ts`. Never used in
 * `apps/launcher/launcher-web`, which mounts the slice's `settings/` directory under
 * its own `/settings` layout; the context shape matches so the route files
 * type-check under both roots.
 */
export const Route = createRootRouteWithContext<RouterContext>()({ component: Outlet })
