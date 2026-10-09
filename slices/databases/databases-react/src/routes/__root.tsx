import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'

import type { RouterContext } from '../router-context.ts'

/**
 * Standalone root anchoring `routeTree.gen.ts`. Never used inside
 * `apps/launcher/launcher-web` (the slice's `settings/` is mounted under the app's
 * own root) — but the context shape must match so the same route files
 * type-check under both roots.
 */
export const Route = createRootRouteWithContext<RouterContext>()({ component: Outlet })
