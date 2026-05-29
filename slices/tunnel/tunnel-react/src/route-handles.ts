import type { AnyRoute } from '@tanstack/react-router'

import { makeTunnelRoute } from './routes/_settings/tunnel/index.tsx'

/**
 * A route factory: given the app-provided parent, it builds a fresh
 * route under it. The macro tree calls each factory once with the parent
 * that owns its bucket; a second call (e.g. a test router) yields an
 * independent object, so there is no shared mutable singleton to collide.
 */
export type RouteFactory = (getParentRoute: () => AnyRoute) => AnyRoute

/**
 * Factories the macro tree mounts under its root (no auth shell). Tunnel
 * has no open routes.
 */
const openRoutes: readonly RouteFactory[] = []

/**
 * Factories the macro tree mounts under its `_auth` layout
 * (`AuthorizedAppShell`). Tunnel has no authenticated (non-settings)
 * routes.
 */
const authRoutes: readonly RouteFactory[] = []

/**
 * Factories the macro tree mounts under its `/settings` layout
 * (`SettingsLayout`). Slice-local URLs already include the `/settings`
 * prefix.
 */
const settingsRoutes: readonly RouteFactory[] = [makeTunnelRoute]

export { openRoutes, authRoutes, settingsRoutes }
