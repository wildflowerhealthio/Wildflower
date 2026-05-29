import type { AnyRoute } from '@tanstack/react-router'

import { makeAppsHomeRoute } from './routes/_auth/apps/index.tsx'

/**
 * A route factory: given the app-provided parent, it builds a fresh
 * route under it. The macro tree calls each factory once with the parent
 * that owns its bucket; a second call (e.g. a test router) yields an
 * independent object, so there is no shared mutable singleton to collide.
 */
export type RouteFactory = (getParentRoute: () => AnyRoute) => AnyRoute

/**
 * Factories the macro tree mounts under its root (no auth shell). Each
 * factory's path literal is the slice-local URL. Apps has no open routes.
 */
const openRoutes: readonly RouteFactory[] = []

/**
 * Factories the macro tree mounts under its `_auth` layout
 * (`AuthorizedAppShell`). Slice-local URLs are preserved.
 */
const authRoutes: readonly RouteFactory[] = [makeAppsHomeRoute]

/**
 * Factories the macro tree mounts under its `/settings` layout
 * (`SettingsLayout`). Apps has no settings routes.
 */
const settingsRoutes: readonly RouteFactory[] = []

export { openRoutes, authRoutes, settingsRoutes }
