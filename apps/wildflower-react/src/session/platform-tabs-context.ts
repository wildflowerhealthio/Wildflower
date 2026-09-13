import { createContext, useContext } from 'react'

import type { TabSpec } from './tabs.ts'

/**
 * Per-entry tabs the primary bar renders after the shared {@link TABS},
 * threaded from the entry through {@link PlatformTabsProvider} exactly as
 * `platformSettingsItems` is.
 *
 * A React context rather than TanStack router context because this app's router
 * hooks are untyped. Defaults to `[]`, so a bar mounted outside a provider
 * renders the shared tabs alone.
 */
const PlatformTabsContext = createContext<readonly TabSpec[]>([])

/** Read the entry's platform-specific tabs. */
const usePlatformTabs = (): readonly TabSpec[] => useContext(PlatformTabsContext)

export { PlatformTabsContext, usePlatformTabs }
