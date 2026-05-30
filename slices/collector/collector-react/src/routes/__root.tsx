import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'

import type { RouterContext } from '../router-context.ts'

/**
 * Standalone root for the collector slice's own file-based route tree.
 * The generator needs a `__root` to anchor `routeTree.gen.ts` so the
 * slice type-checks in isolation. In `apps/wildflower-react` the slice's
 * `_auth/` directory is mounted under the app's own `_auth` layout via
 * `@tanstack/virtual-file-routes`, so this root is never used there — but
 * the context shape must match the app's so the same route files (whose
 * loaders read `context.runAuthed`) type-check under both roots.
 */
export const Route = createRootRouteWithContext<RouterContext>()({ component: Outlet })
