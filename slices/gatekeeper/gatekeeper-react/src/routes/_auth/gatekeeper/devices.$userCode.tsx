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
  // `key={userCode}` remounts the form on a userCode change so its once-seeded
  // `draft`/`name` state can't carry from a previously-viewed request.
  return <DeviceConsentForm key={userCode} consent={consent} onDone={onDone} />
}

/**
 * The `/gatekeeper/devices/$userCode` file route — the public device
 * consent screen reached from the public code-entry page. Renders the
 * shared {@link DeviceConsentForm} under a header with no back link
 * (entered via the published device-flow URL); on a decision it lands the
 * owner in their access settings.
 *
 * The owner-facing equivalent (`/settings/gatekeeper/devices/$userCode`)
 * renders the same form with a back link to the in-settings entry page.
 *
 * Reads the typed `$userCode` path param via `Route.useParams()`. The
 * `_auth` `beforeLoad` gate guarantees a token before this loader runs, so
 * it's a plain `ensureQueryData` — failures propagate to `errorComponent`.
 *
 * The same form is reused by the in-app {@link DeviceConsentModalHost}
 * popup (Tauri-only), which dismisses the modal on `onDone` instead of
 * navigating.
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
    context.queryClient.query({
      ...deviceConsentQueryOptions(context.runAuthed, params.userCode),
      staleTime: 'static',
    }),
  component: DeviceConsentRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Device Authorization" />,
})
