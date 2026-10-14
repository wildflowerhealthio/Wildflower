import { createFileRoute, useRouter } from '@tanstack/react-router'
import { AsyncErrorView, PageHeader } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

import { deviceConsentQueryOptions, useDeviceConsentQuery } from '../../../queries/index.ts'
import { DeviceConsentForm } from '../../../screens/pending-consent/device-consent-form.tsx'

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
 * The `/authorization/devices/$userCode` file route — the public device
 * consent screen reached from the public code-entry page. Renders the
 * shared {@link DeviceConsentForm} under a header with no back link
 * (entered via the published device-flow URL); on a decision it lands the
 * owner on the app root.
 *
 * Reads the typed `$userCode` path param via `Route.useParams()`. The
 * `_auth` `beforeLoad` gate guarantees a token before this loader runs, so
 * it's a plain `ensureQueryData` — failures propagate to `errorComponent`.
 */
function DeviceConsentRoute(): JSX.Element {
  const { userCode } = Route.useParams()
  // The app root is the app's own route, not one of this slice's, so the
  // decision lands there through the history, under the router's basepath.
  const { history, basepath } = useRouter()
  return (
    <>
      <PageHeader title="Authorize Device" />
      <DeviceConsentScreen
        userCode={userCode}
        onDone={() => {
          history.push(basepath)
        }}
      />
    </>
  )
}

export const Route = createFileRoute('/_auth/authorization/devices/$userCode')({
  loader: ({ context, params }) =>
    context.queryClient.query({
      ...deviceConsentQueryOptions(context.runAuthed, params.userCode),
      staleTime: 'static',
    }),
  component: DeviceConsentRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Device Authorization" />,
})
