import type { AnyRoute } from '@tanstack/react-router'

import { Route as DevicesOpen } from './routes/_open/gatekeeper/devices.tsx'
import { Route as OAuthPolling } from './routes/_open/gatekeeper/oauth-polling.$id.tsx'

import { Route as DeviceConsent } from './routes/_auth/gatekeeper/devices.$userCode.tsx'
import { Route as OAuthConsent } from './routes/_auth/gatekeeper/oauth-consent.$id.tsx'

import { Route as AccessIndex } from './routes/_settings/gatekeeper/index.tsx'
import { Route as ApprovedAppDetail } from './routes/_settings/gatekeeper/approved.$id.tsx'
import { Route as RequestsList } from './routes/_settings/gatekeeper/requests.tsx'
import { Route as RequestDetail } from './routes/_settings/gatekeeper/requests.$id.tsx'

/**
 * Routes the macro tree attaches under its root (no auth shell).
 * Each route's literal is the slice-local URL; the macro adds nothing
 * because open routes mount directly at root.
 */
export const openSubtree: readonly AnyRoute[] = [DevicesOpen, OAuthPolling]

/**
 * Routes the macro tree attaches under its `_auth` layout
 * (`AuthorizedAppShell`). Slice-local URLs are preserved.
 */
export const authSubtree: readonly AnyRoute[] = [DeviceConsent, OAuthConsent]

/**
 * Routes the macro tree attaches under its `/settings` layout
 * (`SettingsLayout`). Slice-local URLs already include the `/settings`
 * prefix (the slice's routes-config mounts the `_settings/` directory
 * at `/settings`).
 */
export const settingsSubtree: readonly AnyRoute[] = [
  AccessIndex,
  RequestsList,
  RequestDetail,
  ApprovedAppDetail,
]
