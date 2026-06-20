import { createFileRoute } from '@tanstack/react-router'
import { databasesSettingsItemsFragment } from 'databases-react'
import { gatekeeperSettingsItemsFragment } from 'gatekeeper-react'
import type { JSX } from 'react'
import { ItemList, PageHeader } from 'react-tundraish'
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
  ...databasesSettingsItemsFragment,
]

/**
 * Index of `/settings`. Renders the section's single "Settings" header
 * (this is a top-level tab, so no back link) followed by one row per
 * slice that opts in via `*SettingsItemsFragment`; each row deep-links to
 * a route mounted by the slice's settings subtree.
 */
function SettingsIndex(): JSX.Element {
  return (
    <>
      <PageHeader title="Settings" />
      <ItemList items={settingsItems} />
    </>
  )
}

const Route = createFileRoute('/settings/')({ component: SettingsIndex })

export { Route, SettingsIndex }
