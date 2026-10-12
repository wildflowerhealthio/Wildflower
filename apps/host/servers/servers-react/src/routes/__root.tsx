import { createRootRouteWithContext } from '@tanstack/react-router'

import { BaseLayout } from '../base-layout.tsx'
import type { RouterContext } from '../router-context.ts'

/**
 * Standalone root anchoring `routeTree.gen.ts`, for the package's own type
 * checks and tests. Never used inside `apps/host/host-app`, which mounts
 * `_servers/` under its own root and its own `_servers` layout; its component
 * is that layout's, `BaseLayout`, so the tests see the base's screens as the
 * app shows them. The context shape must match so the same route files
 * type-check under both roots.
 */
export const Route = createRootRouteWithContext<RouterContext>()({ component: BaseLayout })
