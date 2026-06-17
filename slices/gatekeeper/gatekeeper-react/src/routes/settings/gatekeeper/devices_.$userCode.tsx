import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { JSX } from 'react'
import { AsyncErrorView, PageHeader } from 'react-tundraish'

import { deviceConsentQueryOptions } from '../../../queries/index.ts'
import { DeviceConsentScreen } from '../../../screens/device/device-consent-screen.tsx'

/**
 * The `/settings/gatekeeper/devices/$userCode` file route — the
 * owner-facing device consent screen reached from the in-settings
 * code-entry page. Renders the same {@link DeviceConsentScreen} as the
 * public `/gatekeeper/devices/$userCode` surface but with a back link to
 * the in-settings entry page; on a decision it returns to the access page.
 *
 * The filename's trailing underscore (`devices_`) opts this route OUT of
 * nesting under the `devices` entry route (which renders no `<Outlet />`),
 * so the consent screen replaces the entry form at this URL instead of
 * being swallowed — the same pattern `requests_` uses for request detail.
 *
 * Reads the typed `$userCode` path param via `Route.useParams()`. The
 * `/settings` `beforeLoad` gate guarantees a token before this loader
 * runs, so it's a plain `ensureQueryData` — failures propagate to
 * `errorComponent`.
 */
function SettingsDeviceConsentRoute(): JSX.Element {
  const { userCode } = Route.useParams()
  const navigate = useNavigate()
  return (
    <>
      <PageHeader title="Authorize Device" backHref="/settings/gatekeeper/devices" />
      <DeviceConsentScreen
        userCode={userCode}
        onDone={() => {
          void navigate({ to: '/settings/gatekeeper' })
        }}
      />
    </>
  )
}

export const Route = createFileRoute('/settings/gatekeeper/devices_/$userCode')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      deviceConsentQueryOptions(context.runAuthed, params.userCode)
    ),
  component: SettingsDeviceConsentRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Device Authorization" />,
})
