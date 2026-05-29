import type { AnyRoute } from '@tanstack/react-router'

import { Route as AccountConfig } from './routes/_auth/collector/account.$id.tsx'
import { Route as AccountNew } from './routes/_auth/collector/account.new.tsx'
import { Route as AccountList } from './routes/_auth/collector/index.tsx'

/**
 * Routes the macro tree attaches under its root (no auth shell).
 * Each route's literal is the slice-local URL; the macro adds nothing
 * because open routes mount directly at root. Collector has no open
 * routes — every flow is owner-only.
 */
export const openSubtree: readonly AnyRoute[] = []

/**
 * Routes the macro tree attaches under its `_auth` layout
 * (`AuthorizedAppShell`). Slice-local URLs are preserved.
 */
export const authSubtree: readonly AnyRoute[] = [AccountList, AccountNew, AccountConfig]

/**
 * Routes the macro tree attaches under its `/settings` layout
 * (`SettingsLayout`). Slice-local URLs already include the `/settings`
 * prefix. Collector is top-level functionality, not a settings concern,
 * so this is empty.
 */
export const settingsSubtree: readonly AnyRoute[] = []
