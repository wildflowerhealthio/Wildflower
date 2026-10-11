import { createFileRoute } from '@tanstack/react-router'
import { appsSettingsItemsFragment } from '@wildflowerhealthio/apps-react'
import { POLICY_IDS, POLICY_LABELS, policyUrl } from '@wildflowerhealthio/branding-core'
import { databasesSettingsItemsFragment } from '@wildflowerhealthio/databases-react'
import { gatekeeperSettingsItemsFragment } from '@wildflowerhealthio/gatekeeper-react'
import { ItemList, PageHeader } from '@wildflowerhealthio/react-tundraish'
import { requestLogSettingsItemsFragment } from '@wildflowerhealthio/request-log-react'
import type { SettingsItem } from '@wildflowerhealthio/shared-structures-react'
import type { JSX } from 'react'

import { usePlatformSettingsItems } from '../../session/platform-settings-items-context.ts'
import { useTelemetrySettingsItems } from '../../session/telemetry-settings-items.ts'

/**
 * Compile-time concatenation of every slice's
 * `<slice>SettingsItemsFragment`. Fragment-declaration order is
 * canonical for v1 — sorting and grouping are v2 concerns (issue #47).
 * The entry's rows (the Telemetry row, the web logout POST) are
 * appended after these — the entry, not this route, decides those.
 */
const sliceSettingsItems: readonly SettingsItem[] = [
  ...requestLogSettingsItemsFragment,
  ...gatekeeperSettingsItemsFragment,
  ...databasesSettingsItemsFragment,
  ...appsSettingsItemsFragment,
]

/**
 * The Legal rows every entry ends on: the privacy policy, the terms of use and
 * the deletion page on the canonical site, opened in a new tab (the system
 * browser, inside Wildflower Host's webview). The app stores require the apps
 * to link to the first and the last.
 */
const legalSettingsItems: readonly SettingsItem[] = POLICY_IDS.map((id) => ({
  id: `legal-${id}`,
  title: POLICY_LABELS[id],
  href: policyUrl(id),
  external: true,
}))

/**
 * Index of `/settings`. Renders the section's single "Settings" header
 * (this is a top-level tab, so no back link) followed by one row per
 * slice that opts in via `*SettingsItemsFragment`, then the entry's own
 * rows, `entrySettingsItems` (e.g. the Telemetry row and the web logout row),
 * then the Legal rows.
 *
 * Presentational and prop-driven — the route binding below feeds
 * `entrySettingsItems` from the entry's providers, so this component stays
 * trivially testable without standing up the app's full context.
 */
function SettingsIndex({
  entrySettingsItems,
}: {
  readonly entrySettingsItems: readonly SettingsItem[]
}): JSX.Element {
  return (
    <>
      <PageHeader title="Settings" />
      <ItemList items={[...sliceSettingsItems, ...entrySettingsItems, ...legalSettingsItems]} />
    </>
  )
}

/**
 * Route binding: reads the entry's rows and hands them to the presentational
 * {@link SettingsIndex}: the Telemetry row where the entry mounted the consent
 * gate ({@link useTelemetrySettingsItems}), then the entry's platform settings
 * rows from the {@link usePlatformSettingsItems} provider.
 */
function SettingsIndexRoute(): JSX.Element {
  const telemetrySettingsItems = useTelemetrySettingsItems()
  const platformSettingsItems = usePlatformSettingsItems()
  return (
    <SettingsIndex entrySettingsItems={[...telemetrySettingsItems, ...platformSettingsItems]} />
  )
}

const Route = createFileRoute('/settings/')({ component: SettingsIndexRoute })

export { Route, SettingsIndex, SettingsIndexRoute }
