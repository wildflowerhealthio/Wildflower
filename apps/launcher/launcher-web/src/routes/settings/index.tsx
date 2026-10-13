import { createFileRoute } from '@tanstack/react-router'
import { appsSettingsItemsFragment } from '@wildflowerhealthio/apps-react'
import { POLICY_IDS, POLICY_LABELS, policyUrl } from '@wildflowerhealthio/branding-core'
import { databasesSettingsItemsFragment } from '@wildflowerhealthio/databases-react'
import { ItemList, PageHeader } from '@wildflowerhealthio/react-tundraish'
import { requestLogSettingsItemsFragment } from '@wildflowerhealthio/request-log-react'
import type { SettingsItem } from '@wildflowerhealthio/shared-structures-react'
import { Option } from 'effect'
import type { JSX } from 'react'

import { useLogoutSettingsItem } from '../../session/logout-settings-item-context.ts'
import { useManageAccessSettingsItem } from '../../session/manage-access-settings-item.ts'
import { useTelemetrySettingsItems } from '../../session/telemetry-settings-items.ts'

/**
 * Compile-time concatenation of every slice's
 * `<slice>SettingsItemsFragment`. Fragment-declaration order is
 * canonical for v1 — sorting and grouping are v2 concerns (issue #47).
 * The app's own rows (the Manage access row, the Telemetry row, the Logout
 * row) are appended after these.
 */
const sliceSettingsItems: readonly SettingsItem[] = [
  ...requestLogSettingsItemsFragment,
  ...databasesSettingsItemsFragment,
  ...appsSettingsItemsFragment,
]

/**
 * The Legal rows the settings screen ends on: the privacy policy, the consumer health
 * data policy, the terms of use and the deletion page on the canonical site,
 * opened in a new tab (the system browser, inside Wildflower Host's webview). The app stores require the apps
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
 * slice that opts in via `*SettingsItemsFragment`, then the app's own
 * rows, `appSettingsItems` (the Manage access row, the Telemetry row and the
 * Logout row), then the Legal rows.
 *
 * Presentational and prop-driven — the route binding below feeds
 * `appSettingsItems` from the app's providers, so this component stays
 * trivially testable without standing up the app's full context.
 */
function SettingsIndex({
  appSettingsItems,
}: {
  readonly appSettingsItems: readonly SettingsItem[]
}): JSX.Element {
  return (
    <>
      <PageHeader title="Settings" backHref="/home" backLabel="Apps" />
      <ItemList items={[...sliceSettingsItems, ...appSettingsItems, ...legalSettingsItems]} />
    </>
  )
}

/**
 * Route binding: reads the app's rows and hands them to the presentational
 * {@link SettingsIndex}: the Manage access row, a link out to the session's
 * server's Wildflower Authorization app ({@link useManageAccessSettingsItem}),
 * the Telemetry row inside the consent gate ({@link useTelemetrySettingsItems}),
 * then the Logout row ({@link useLogoutSettingsItem}).
 */
function SettingsIndexRoute(): JSX.Element {
  const manageAccessSettingsItem = useManageAccessSettingsItem()
  const telemetrySettingsItems = useTelemetrySettingsItems()
  const logoutSettingsItem = useLogoutSettingsItem()
  return (
    <SettingsIndex
      appSettingsItems={[
        ...Option.toArray(manageAccessSettingsItem),
        ...telemetrySettingsItems,
        ...Option.toArray(logoutSettingsItem),
      ]}
    />
  )
}

const Route = createFileRoute('/settings/')({ component: SettingsIndexRoute })

export { Route, SettingsIndex, SettingsIndexRoute }
