import { createContext, useContext } from 'react'

import type { TabSpec } from './tabs.ts'

/**
 * Per-entry tabs the primary bar renders after the shared {@link TABS}.
 * Threaded from the entry (the only place that knows the platform) through
 * {@link PlatformTabsProvider}, exactly as `platformSettingsItems` is: the
 * Tauri entry contributes the HAR Recorder tab, every web entry contributes
 * none.
 *
 * A React context (not TanStack router context) because this app's router
 * hooks are untyped — components read app-provided data through typed contexts
 * like this one. Defaults to `[]` so a bar mounted outside a provider (an
 * isolated unit test, say) simply renders the shared tabs.
 */
const PlatformTabsContext = createContext<readonly TabSpec[]>([])

/** Read the entry's platform-specific tabs. */
const usePlatformTabs = (): readonly TabSpec[] => useContext(PlatformTabsContext)

export { PlatformTabsContext, usePlatformTabs }
