import { createRootRoute, Outlet } from '@tanstack/react-router'

/**
 * Standalone root for the tunnel slice's own file-based route tree. The
 * generator needs a `__root` to anchor `routeTree.gen.ts` so the slice
 * type-checks in isolation. In `apps/wildflower-react` the slice's
 * `settings/` directory is mounted under the app's own root via
 * `@tanstack/virtual-file-routes`, so this root is never used there.
 */
export const Route = createRootRoute({ component: Outlet })
