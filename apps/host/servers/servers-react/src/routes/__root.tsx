import { createRootRouteWithContext } from '@tanstack/react-router'

import type { RouterContext } from '../router-context.ts'

/**
 * Standalone root anchoring `routeTree.gen.ts`, for the package's own type
 * checks and tests. Never used inside `apps/host/host-app`, which mounts
 * `servers/` and `settings.tsx` under its own root. The context shape must
 * match so the same route files type-check under both roots.
 */
export const Route = createRootRouteWithContext<RouterContext>()()
