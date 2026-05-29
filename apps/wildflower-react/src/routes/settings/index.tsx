import { createFileRoute } from '@tanstack/react-router'
import { gatekeeperSettingsItemsFragment } from 'gatekeeper-react'
import type { JSX } from 'react'
import { ItemList } from 'react-tundraish'
import type { SettingsItem } from 'shared-structures-react'
import { tunnelSettingsItemsFragment } from 'tunnel-react'

/**
 * Compile-time concatenation of every slice's
 * `<slice>SettingsItemsFragment`. Fragment-declaration order is
 * canonical for v1 — sorting and grouping are v2 concerns (issue #47).
 */
const settingsItems: readonly SettingsItem[] = [
  ...tunnelSettingsItemsFragment,
  ...gatekeeperSettingsItemsFragment,
]

/**
 * Index of `/settings`. Renders one row per slice that opts in via
 * `*SettingsItemsFragment`; each row deep-links to a route mounted by
 * the slice's settings subtree.
 */
function SettingsIndex(): JSX.Element {
  return <ItemList items={settingsItems} />
}

const Route = createFileRoute('/settings/')({ component: SettingsIndex })

export { Route, SettingsIndex }
