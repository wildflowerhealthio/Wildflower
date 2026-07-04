import { createContext, useContext } from 'react'
import type { SettingsItem } from 'shared-structures-react'

/**
 * Per-entry settings rows the `/settings` route appends after every slice's
 * `*SettingsItemsFragment`. Threaded from the entry (the only place that knows
 * the platform) through {@link PlatformSettingsItemsProvider} rather than a
 * boolean the route branches on: the standalone-web entries provide the web
 * logout row; `main-tauri` provides `[]`.
 *
 * A React context (not TanStack router context) because this app's router
 * hooks are untyped — components read app-provided data through typed contexts
 * like this one, the same way `AuthTokenProvider` threads the auth store.
 * Defaults to `[]` so a component mounted outside a provider (e.g. an isolated
 * unit test) simply renders no platform rows.
 */
const PlatformSettingsItemsContext = createContext<readonly SettingsItem[]>([])

/** Read the entry's platform-specific settings rows. */
const usePlatformSettingsItems = (): readonly SettingsItem[] =>
  useContext(PlatformSettingsItemsContext)

export { PlatformSettingsItemsContext, usePlatformSettingsItems }
