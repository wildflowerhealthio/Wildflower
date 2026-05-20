import { collectorSettingsItemsFragment } from 'collector-react'
import { gatekeeperSettingsItemsFragment } from 'gatekeeper-react'
import type { JSX } from 'react'
import { ItemList, pageLayoutStyles } from 'react-tundraish'
import type { SettingsItem } from 'shared-structures-react'
import { tunnelSettingsItemsFragment } from 'tunnel-react'

/**
 * Compile-time concatenation of every slice's
 * `<slice>SettingsItemsFragment`. Fragment-declaration order is
 * canonical for v1 — sorting and grouping are v2 concerns (issue #47).
 */
const settingsItems: readonly SettingsItem[] = [
  ...tunnelSettingsItemsFragment,
  ...collectorSettingsItemsFragment,
  ...gatekeeperSettingsItemsFragment,
]

/**
 * Aggregated `/settings` landing screen. Renders one row per slice
 * that opts in via `*SettingsItemsFragment`; each row deep-links to a
 * route mounted by the slice's `*SettingsRoutesFragment`.
 */
const SettingsScreen = (): JSX.Element => (
  <div className={pageLayoutStyles['page']}>
    <h1 className="text-heading-4">Settings</h1>
    <ItemList items={settingsItems} />
  </div>
)

export { SettingsScreen }
