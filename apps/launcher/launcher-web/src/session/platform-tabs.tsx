import type { JSX, ReactNode } from 'react'

import { PlatformTabsContext } from './platform-tabs-context.ts'
import type { TabSpec } from './tabs.ts'

/**
 * Provides the entry's platform-specific tabs (e.g. the Tauri shell's HAR
 * Recorder) to the tree, read by `<TabBar>` via {@link usePlatformTabs}. See
 * {@link PlatformTabsContext}.
 */
const PlatformTabsProvider = ({
  tabs,
  children,
}: {
  readonly tabs: readonly TabSpec[]
  readonly children: ReactNode
}): JSX.Element => (
  <PlatformTabsContext.Provider value={tabs}>{children}</PlatformTabsContext.Provider>
)

export { PlatformTabsProvider }
