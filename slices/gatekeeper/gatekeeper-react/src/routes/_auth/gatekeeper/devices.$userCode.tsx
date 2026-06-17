import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { JSX } from 'react'
import { AsyncErrorView, PageHeader } from 'react-tundraish'

import { deviceConsentQueryOptions } from '../../../queries/index.ts'
import { DeviceConsentScreen } from '../../../screens/device/device-consent-screen.tsx'

/**
 * The `/gatekeeper/devices/$userCode` file route — the public device
 * consent screen reached from the public code-entry page. Renders the
 * shared {@link DeviceConsentScreen} under a header with no back link
 * (entered via the published device-flow URL); on a decision it lands the
 * owner in their access settings.
 *
 * The owner-facing equivalent (`/settings/gatekeeper/devices/$userCode`)
 * renders the same screen with a back link to the in-settings entry page.
 *
 * Reads the typed `$userCode` path param via `Route.useParams()`. The
 * `_auth` `beforeLoad` gate guarantees a token before this loader runs, so
 * it's a plain `ensureQueryData` — failures propagate to `errorComponent`.
 */
function DeviceConsentRoute(): JSX.Element {
  const { userCode } = Route.useParams()
  const navigate = useNavigate()
  return (
    <>
      <PageHeader title="Authorize Device" />
      <DeviceConsentScreen
        userCode={userCode}
        onDone={() => {
          void navigate({ to: '/settings/gatekeeper' })
        }}
      />
    </>
  )
}

export const Route = createFileRoute('/_auth/gatekeeper/devices/$userCode')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      deviceConsentQueryOptions(context.runAuthed, params.userCode)
    ),
  component: DeviceConsentRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Device Authorization" />,
})
