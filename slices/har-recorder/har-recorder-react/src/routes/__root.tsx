import { createRootRoute, Outlet } from '@tanstack/react-router'

/**
 * Standalone root for the slice's own file-based route tree — the anchor
 * `routeTree.gen.ts` needs so the slice type-checks in isolation.
 *
 * @remarks
 * Context-free: the recorder page talks to the host over bridges, not over
 * HTTP, so there is no router context to keep in step with the app's. Unused in
 * `apps/wildflower-react`, which mounts the `_auth/` directory under its own
 * `_auth` layout.
 */
export const Route = createRootRoute({ component: Outlet })
