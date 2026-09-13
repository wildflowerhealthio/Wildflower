import { createRootRoute, Outlet } from '@tanstack/react-router'

/**
 * Standalone root for the HAR Recorder slice's own file-based route tree — the
 * anchor `routeTree.gen.ts` needs so the slice type-checks in isolation.
 *
 * @remarks
 * Context-free, unlike the collector's: the recorder page reads nothing from
 * router context (it talks to the host over bridges, not over HTTP), so there
 * is no context shape to keep in step with the app's. In
 * `apps/wildflower-react` this root is unused — the slice's `_auth/har-recorder`
 * directory is mounted under the app's own `_auth` layout via
 * `@tanstack/virtual-file-routes`.
 */
export const Route = createRootRoute({ component: Outlet })
