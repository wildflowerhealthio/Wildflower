import { physical, rootRoute } from '@tanstack/virtual-file-routes'

/**
 * Three subtree mounts at the slice root. Each subdirectory's contents
 * land at the URL prefix the app expects when the macro composes them:
 *
 *   - `_open/`     → slice-local URLs (`/gatekeeper/devices`, etc.)
 *   - `_auth/`     → slice-local URLs (`/gatekeeper/oauth-consent/$id`, etc.)
 *   - `_settings/` → prefixed with `/settings` (`/settings/gatekeeper/...`)
 *
 * The leading `_` in the directory names is a slice-internal convention
 * to bucket routes by auth/settings intent; it doesn't appear in URLs.
 * The app's macro tree wraps each bucket with the appropriate layout
 * (`AuthorizedAppShell` for `_auth`/`_settings`, `SettingsLayout` for
 * `_settings`) at runtime via `addChildren`.
 */
export default rootRoute('slice-root.tsx', [
  physical('/', 'routes/_open'),
  physical('/', 'routes/_auth'),
  physical('/settings', 'routes/_settings'),
])
