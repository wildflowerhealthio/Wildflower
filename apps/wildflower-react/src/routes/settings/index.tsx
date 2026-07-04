import { createFileRoute } from '@tanstack/react-router'
import { databasesSettingsItemsFragment } from 'databases-react'
import { gatekeeperSettingsItemsFragment } from 'gatekeeper-react'
import type { JSX } from 'react'
import { ItemList, PageHeader } from 'react-tundraish'
import type { SettingsItem } from 'shared-structures-react'
import { tunnelSettingsItemsFragment } from 'tunnel-react'

import { usePlatformSettingsItems } from '../../session/platform-settings-items-context.ts'

/**
 * Compile-time concatenation of every slice's
 * `<slice>SettingsItemsFragment`. Fragment-declaration order is
 * canonical for v1 — sorting and grouping are v2 concerns (issue #47).
 * Platform-specific rows (e.g. the web logout POST) are appended after
 * these from `context.platformSettingsItems` — the entry, not this
 * route, decides those.
 */
const sliceSettingsItems: readonly SettingsItem[] = [
  ...tunnelSettingsItemsFragment,
  ...gatekeeperSettingsItemsFragment,
  ...databasesSettingsItemsFragment,
]

/**
 * Index of `/settings`. Renders the section's single "Settings" header
 * (this is a top-level tab, so no back link) followed by one row per
 * slice that opts in via `*SettingsItemsFragment`, then the entry's
 * `platformSettingsItems` (e.g. the web logout row).
 *
 * Presentational and prop-driven — the route binding below feeds
 * `platformSettingsItems` from router context, so this component stays
 * trivially testable without standing up the app's full context.
 */
function SettingsIndex({
  platformSettingsItems,
}: {
  readonly platformSettingsItems: readonly SettingsItem[]
}): JSX.Element {
  return (
    <>
      <PageHeader title="Settings" />
      <ItemList items={[...sliceSettingsItems, ...platformSettingsItems]} />
    </>
  )
}

/**
 * Route binding: reads the entry's platform settings rows from the
 * {@link usePlatformSettingsItems} provider and hands them to the
 * presentational {@link SettingsIndex}.
 */
function SettingsIndexRoute(): JSX.Element {
  const platformSettingsItems = usePlatformSettingsItems()
  return <SettingsIndex platformSettingsItems={platformSettingsItems} />
}

const Route = createFileRoute('/settings/')({ component: SettingsIndexRoute })

export { Route, SettingsIndex }
