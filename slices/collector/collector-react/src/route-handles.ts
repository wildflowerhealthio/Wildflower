import type { AnyRoute } from '@tanstack/react-router'

import { makeAccountConfigRoute } from './routes/_auth/collector/account.$id.tsx'
import { makeAccountNewRoute } from './routes/_auth/collector/account.new.tsx'
import { makeAccountListRoute } from './routes/_auth/collector/index.tsx'

/**
 * A route factory: given the app-provided parent, it builds a fresh
 * route under it. The macro tree calls each factory once with the parent
 * that owns its bucket; a second call (e.g. a test router) yields an
 * independent object, so there is no shared mutable singleton to collide.
 */
export type RouteFactory = (getParentRoute: () => AnyRoute) => AnyRoute

/**
 * Factories the macro tree mounts under its root (no auth shell).
 * Collector has no open routes — every flow is owner-only.
 */
const openRoutes: readonly RouteFactory[] = []

/**
 * Factories the macro tree mounts under its `_auth` layout
 * (`AuthorizedAppShell`). Slice-local URLs are preserved.
 */
const authRoutes: readonly RouteFactory[] = [
  makeAccountListRoute,
  makeAccountNewRoute,
  makeAccountConfigRoute,
]

/**
 * Factories the macro tree mounts under its `/settings` layout
 * (`SettingsLayout`). Collector is top-level functionality, not a
 * settings concern, so this is empty.
 */
const settingsRoutes: readonly RouteFactory[] = []

export { openRoutes, authRoutes, settingsRoutes }
