import type { AnyRoute } from '@tanstack/react-router'

import { Route as AppsHome } from './routes/_auth/apps/index.tsx'

/**
 * Routes the macro tree attaches under its root (no auth shell).
 * Each route's literal is the slice-local URL; the macro adds nothing
 * because open routes mount directly at root. Apps has no open routes.
 */
export const openSubtree: readonly AnyRoute[] = []

/**
 * Routes the macro tree attaches under its `_auth` layout
 * (`AuthorizedAppShell`). Slice-local URLs are preserved.
 */
export const authSubtree: readonly AnyRoute[] = [AppsHome]

/**
 * Routes the macro tree attaches under its `/settings` layout
 * (`SettingsLayout`). Slice-local URLs already include the `/settings`
 * prefix. Apps has no settings routes.
 */
export const settingsSubtree: readonly AnyRoute[] = []
