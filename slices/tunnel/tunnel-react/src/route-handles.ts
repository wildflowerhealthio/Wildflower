import type { AnyRoute } from '@tanstack/react-router'

import { Route as TunnelScreen } from './routes/_settings/tunnel/index.tsx'

/**
 * Routes the macro tree attaches under its root (no auth shell).
 * Each route's literal is the slice-local URL; the macro adds nothing
 * because open routes mount directly at root. Tunnel has no open routes.
 */
export const openSubtree: readonly AnyRoute[] = []

/**
 * Routes the macro tree attaches under its `_auth` layout
 * (`AuthorizedAppShell`). Slice-local URLs are preserved. Tunnel has no
 * authenticated (non-settings) routes.
 */
export const authSubtree: readonly AnyRoute[] = []

/**
 * Routes the macro tree attaches under its `/settings` layout
 * (`SettingsLayout`). Slice-local URLs already include the `/settings`
 * prefix (the slice's routes-config mounts the `_settings/` directory
 * at `/settings`).
 */
export const settingsSubtree: readonly AnyRoute[] = [TunnelScreen]
