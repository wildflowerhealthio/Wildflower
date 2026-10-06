import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import type { JSX } from 'react'
import { ItemList, type ItemListItem, PageHeader } from 'react-tundraish'
import type { HostCommandError, NotificationPermission } from 'servers-core'
import { telemetryConsentSummary, useTelemetryConsentControls } from 'telemetry-react'

import {
  appVersionQueryOptions,
  notificationPermissionQueryOptions,
  useRequestNotificationPermission,
} from './queries.ts'
import type { RouterContext } from './router-context.ts'

/** What the Notifications row says under its title for each permission. */
const NOTIFICATION_PERMISSION_SUBTITLE: Readonly<Record<NotificationPermission, string>> = {
  granted: "Allowed — you'll get a notification if a server stops or is paused.",
  denied:
    'Blocked — to hear when a server stops, allow notifications for Wildflower in your system settings.',
  prompt: 'Not asked yet — select to allow notifications when a server stops.',
}

/**
 * The Notifications row: whether the OS lets the app post notifications, and,
 * while the OS has yet to ask, a press that asks.
 */
const useNotificationsItem = (): ItemListItem => {
  const runHostCommand = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.runHostCommand,
  })
  const permission = useQuery(notificationPermissionQueryOptions(runHostCommand))
  const requestPermission = useRequestNotificationPermission(runHostCommand)
  const item = { id: 'notifications', title: 'Notifications' } as const
  if (requestPermission.isError) {
    return { ...item, subtitle: "Couldn't ask the system to allow notifications.", tone: 'danger' }
  }
  if (permission.isError) {
    return {
      ...item,
      subtitle: "Couldn't check whether notifications are allowed.",
      tone: 'danger',
    }
  }
  if (permission.isPending) return { ...item, subtitle: 'Checking…' }
  if (permission.data === 'prompt') {
    return {
      ...item,
      subtitle: NOTIFICATION_PERMISSION_SUBTITLE.prompt,
      onClick: () => {
        requestPermission.mutate()
      },
    }
  }
  return { ...item, subtitle: NOTIFICATION_PERMISSION_SUBTITLE[permission.data] }
}

/** The About section's version row's value. */
const versionText = (version: UseQueryResult<string, HostCommandError>): string => {
  if (version.isSuccess) return version.data
  return version.isError ? 'Unknown' : '…'
}

/**
 * The base's Host Settings, `/settings`, for this device's app rather than
 * any one server (whose settings the web app holds):
 * Notifications, the Telemetry row, and About.
 *
 * @remarks
 * The Telemetry row reads the answer to the base's own consent dialog, by the
 * dialog's copy, and reopens it; so the page renders only inside the base's
 * `TelemetryConsentGate` (`BaseRoot`).
 */
const SettingsPage = (): JSX.Element => {
  const runHostCommand = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.runHostCommand,
  })
  const notificationsItem = useNotificationsItem()
  const consentControls = useTelemetryConsentControls()
  const version = useQuery(appVersionQueryOptions(runHostCommand))
  return (
    <>
      <PageHeader title="Host Settings" backHref="/" backLabel="Servers" />
      <ItemList title="Notifications" items={[notificationsItem]} maxLines={3} />
      <ItemList
        title="Privacy"
        maxLines={3}
        items={[
          {
            id: 'telemetry',
            title: 'Telemetry',
            subtitle: telemetryConsentSummary(consentControls.consent, consentControls.copy),
            onClick: consentControls.reopen,
          },
        ]}
      />
      <ItemList
        title="About"
        maxLines={3}
        items={[
          { id: 'version', title: 'Version', meta: versionText(version) },
          {
            id: 'project',
            title: 'Wildflower Health Project',
            subtitle:
              'An open source experiment in what an interoperable personal health record could look like.',
          },
        ]}
      />
    </>
  )
}

export { SettingsPage }
