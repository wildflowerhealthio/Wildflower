import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { JSX } from 'react'
import { AsyncErrorView, PageHeader } from 'react-tundraish'

import { deviceConsentQueryOptions, useDeviceConsentQuery } from '../../../queries/index.ts'
import { DeviceConsentForm } from '../../../screens/device-consent/device-consent-form.tsx'

const DeviceConsentScreen = ({
  userCode,
  onDone,
}: {
  readonly userCode: string
  readonly onDone: () => void
}): JSX.Element => {
  const { data: consent } = useDeviceConsentQuery(userCode)
  // The settings surface lets the approver rename the device before approving.
  // `key={userCode}` remounts the form on a userCode change so its once-seeded
  // `draft`/`name` state can't carry from a previously-viewed request.
  return <DeviceConsentForm key={userCode} consent={consent} onDone={onDone} editableName />
}

/**
 * The `/settings/gatekeeper/devices/$userCode` file route — the
 * owner-facing device consent screen reached from the in-settings
 * code-entry page. Renders the same {@link DeviceConsentForm} as the
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
    context.queryClient.query({
      ...deviceConsentQueryOptions(context.runAuthed, params.userCode),
      staleTime: 'static',
    }),
  component: SettingsDeviceConsentRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Device Authorization" />,
})
