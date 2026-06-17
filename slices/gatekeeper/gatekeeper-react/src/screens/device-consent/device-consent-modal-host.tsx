/**
 * Floats a non-dismissable device-consent modal over whatever route is
 * currently rendered, driven entirely by the host's
 * `bridge:DeviceConsentRequested` push. Inert until the
 * {@link useActiveDeviceUserCode} hook returns a non-null `userCode`.
 *
 * Mounted exactly once, alongside the router's `<Outlet />` (in
 * `RootShell`), so the popup overlays every route and only one modal
 * can be open at a time.
 */

import { Suspense, useEffect, useState, type JSX } from 'react'
import { Dialog } from 'react-tundraish'

import { useActiveDeviceUserCode } from '../../active-device-consent/use-active-device-user-code.ts'
import { useDeviceConsentQuery } from '../../queries/index.ts'
import { DeviceConsentForm } from './device-consent-form.tsx'

/**
 * Suspense body — fetched against the live `userCode`. Inner so the
 * outer modal frame stays open while the fetch resolves; without this,
 * the Suspense fallback would unmount the Dialog and the modal would
 * flicker shut on every userCode change.
 */
const DeviceConsentDialogBody = ({
  userCode,
  onDone,
}: {
  readonly userCode: string
  readonly onDone: () => void
}): JSX.Element => {
  const { data: consent } = useDeviceConsentQuery(userCode)
  return <DeviceConsentForm consent={consent} onDone={onDone} />
}

const DeviceConsentModalHost = (): JSX.Element => {
  const activeUserCode = useActiveDeviceUserCode()
  // Local mirror of "what userCode did the user just approve/deny?",
  // tracked so the popup closes immediately on `onDone` without
  // waiting for the host's round-trip (HTTP response → Rust republish
  // → bridge event is observable). Resets to `null` whenever the
  // host's active userCode changes, so the next head — including a
  // hypothetical repeat of the just-handled value — opens the popup
  // again.
  const [handledUserCode, setHandledUserCode] = useState<string | null>(null)

  useEffect(() => {
    setHandledUserCode(null)
  }, [activeUserCode])

  const isOpen = activeUserCode !== null && activeUserCode !== handledUserCode

  return (
    <Dialog
      open={isOpen}
      dismissable={false}
      title="Device Authorization"
      onClose={() => {
        // Native `close()` path only fires when the dialog truly
        // closes — for the non-dismissable variant, that's only the
        // controlled `open={false}` rerender. Nothing to do here.
      }}
    >
      {isOpen ? (
        <Suspense fallback={null}>
          <DeviceConsentDialogBody
            userCode={activeUserCode}
            onDone={() => setHandledUserCode(activeUserCode)}
          />
        </Suspense>
      ) : null}
    </Dialog>
  )
}

export { DeviceConsentModalHost }
