import type { JSX, ReactNode } from 'react'
import type { SettingsItem } from 'shared-structures-react'

import { PlatformSettingsItemsContext } from './platform-settings-items-context.ts'

/**
 * Provides the entry's platform-specific settings rows (e.g. the web logout
 * row) to the tree, read by the `/settings` route via
 * {@link usePlatformSettingsItems}. See {@link PlatformSettingsItemsContext}.
 */
const PlatformSettingsItemsProvider = ({
  items,
  children,
}: {
  readonly items: readonly SettingsItem[]
  readonly children: ReactNode
}): JSX.Element => (
  <PlatformSettingsItemsContext.Provider value={items}>
    {children}
  </PlatformSettingsItemsContext.Provider>
)

export { PlatformSettingsItemsProvider }
