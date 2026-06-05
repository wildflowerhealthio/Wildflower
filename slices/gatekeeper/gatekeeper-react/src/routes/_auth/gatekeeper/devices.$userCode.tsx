import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { JSX } from 'react'
import { AsyncErrorView } from 'react-tundraish'

import { deviceConsentQueryOptions, useDeviceConsentQuery } from '../../../queries/index.ts'
import { DeviceConsentForm } from '../../../screens/device-consent/device-consent-form.tsx'

const DeviceConsentScreen = ({ userCode }: { readonly userCode: string }): JSX.Element => {
  const navigate = useNavigate()
  const { data: consent } = useDeviceConsentQuery(userCode)
  return (
    <DeviceConsentForm
      consent={consent}
      onDone={() => {
        void navigate({ to: '/settings/gatekeeper' })
      }}
    />
  )
}

/**
 * The `/gatekeeper/devices/$userCode` file route. Reads the typed
 * `$userCode` path param from the generated route via `Route.useParams()`
 * and hands it to the screen as a prop. The `_auth` `beforeLoad` gate
 * guarantees a token before this loader runs, so it's a plain
 * `ensureQueryData` — failures propagate to `errorComponent`.
 */
function DeviceConsentRoute(): JSX.Element {
  const { userCode } = Route.useParams()
  return <DeviceConsentScreen userCode={userCode} />
}

export const Route = createFileRoute('/_auth/gatekeeper/devices/$userCode')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      deviceConsentQueryOptions(context.runAuthed, params.userCode)
    ),
  component: DeviceConsentRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Device Authorization" />,
})
