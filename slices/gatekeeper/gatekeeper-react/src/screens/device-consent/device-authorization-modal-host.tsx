import { Suspense, useState, type JSX } from 'react'
import { Dialog } from 'react-tundraish'

import { useActiveDeviceRequest } from '../../active-device-request/index.ts'
import { useDeviceConsentQuery } from '../../queries/index.ts'
import { DeviceConsentForm } from './device-consent-form.tsx'

const DeviceConsentDialogBody = ({
  userCode,
  onDone,
}: {
  readonly userCode: string
  readonly onDone: () => void
}): JSX.Element => {
  const { data: consent } = useDeviceConsentQuery(userCode)
  return <DeviceConsentForm consent={consent} onDone={onDone} showHeading={false} />
}

/**
 * In-app host for the device-authorization consent popup. Reads the active
 * device `userCode` pushed natively over the gatekeeper bridge
 * ({@link useActiveDeviceRequest}) and, while one is present, renders a
 * non-dismissable {@link Dialog} over the current page. The dialog's lifetime
 * is owned here, not by the user: there's no close button, backdrop clicks and
 * ESC are inert, and it only goes away once the request is handled or the host
 * pushes a different (or no) head.
 *
 * A handled `userCode` is remembered locally so the popup dismisses the instant
 * an approve/deny resolves, rather than waiting for the native side to re-derive
 * and push the next head. Device user codes are unique per request, so a genuine
 * follow-up request always carries a fresh code and re-opens the dialog.
 *
 * Mount this once, high in the authenticated tree, alongside the router outlet.
 */
const DeviceAuthorizationModalHost = (): JSX.Element => {
  const userCode = useActiveDeviceRequest()
  const [handledUserCode, setHandledUserCode] = useState<string | null>(null)
  const activeUserCode = userCode !== null && userCode !== handledUserCode ? userCode : null

  return (
    <Dialog
      open={activeUserCode !== null}
      dismissable={false}
      onClose={() => undefined}
      title="Device Authorization"
    >
      {activeUserCode !== null ? (
        <Suspense fallback={null}>
          <DeviceConsentDialogBody
            userCode={activeUserCode}
            onDone={() => {
              setHandledUserCode(activeUserCode)
            }}
          />
        </Suspense>
      ) : null}
    </Dialog>
  )
}

export { DeviceAuthorizationModalHost }
