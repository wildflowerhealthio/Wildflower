import type { AnyRoute } from '@tanstack/react-router'

import { makeDeviceConsentRoute } from './routes/_auth/gatekeeper/devices.$userCode.tsx'
import { makeOAuthConsentRoute } from './routes/_auth/gatekeeper/oauth-consent.$id.tsx'
import { makeDeviceEntryRoute } from './routes/_open/gatekeeper/devices.tsx'
import { makeOAuthPollingRoute } from './routes/_open/gatekeeper/oauth-polling.$id.tsx'
import { makeApprovedAppDetailRoute } from './routes/_settings/gatekeeper/approved.$id.tsx'
import { makeAccessIndexRoute } from './routes/_settings/gatekeeper/index.tsx'
import { makeRequestDetailRoute } from './routes/_settings/gatekeeper/requests.$id.tsx'
import { makeRequestsListRoute } from './routes/_settings/gatekeeper/requests.tsx'

/**
 * A route factory: given the app-provided parent, it builds a fresh
 * route under it. The macro tree calls each factory once with the parent
 * that owns its bucket; a second call (e.g. a test router) yields an
 * independent object, so there is no shared mutable singleton to collide.
 */
export type RouteFactory = (getParentRoute: () => AnyRoute) => AnyRoute

/**
 * Factories the macro tree mounts under its root (no auth shell). Each
 * factory's path literal is the slice-local URL. oauth-polling and
 * device-entry are reachable without a bearer.
 */
const openRoutes: readonly RouteFactory[] = [makeDeviceEntryRoute, makeOAuthPollingRoute]

/**
 * Factories the macro tree mounts under its `_auth` layout
 * (`AuthorizedAppShell`). oauth-consent and device-consent require the
 * owner to already be authenticated.
 */
const authRoutes: readonly RouteFactory[] = [makeDeviceConsentRoute, makeOAuthConsentRoute]

/**
 * Factories the macro tree mounts under its `/settings` layout
 * (`SettingsLayout`). Slice-local URLs already include the `/settings`
 * prefix.
 */
const settingsRoutes: readonly RouteFactory[] = [
  makeAccessIndexRoute,
  makeRequestsListRoute,
  makeRequestDetailRoute,
  makeApprovedAppDetailRoute,
]

export { openRoutes, authRoutes, settingsRoutes }
