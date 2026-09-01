/**
 * Floats the device-consent modal over whatever route is currently
 * rendered, driven entirely by the host's `bridge:DeviceConsentRequested`
 * push. Inert until the {@link useActiveDeviceUserCode} hook returns a
 * non-null `userCode`. Dismissable: the × (or ESC / backdrop) closes the
 * popup *without deciding* — the request stays pending and answerable
 * from Settings until it expires.
 *
 * Mounted exactly once, alongside the router's `<Outlet />` (in
 * `RootShell`), so the popup overlays every route and only one modal
 * can be open at a time.
 */

import { unknownErrorToString } from 'kitchen-sink'
import {
  Component,
  Suspense,
  useMemo,
  useState,
  type ErrorInfo,
  type JSX,
  type ReactNode,
} from 'react'
import {
  isAuthed,
  useAuthStateSubscribable,
  useLastRendersValue,
  useSubscribable,
} from 'react-kitchen-sink'
import { Dialog } from 'react-tundraish'

import { useActiveDeviceUserCode } from '../../active-device-consent/use-active-device-user-code.ts'
import { useDeviceConsentQuery } from '../../queries/index.ts'
import { DeviceConsentForm } from './device-consent-form.tsx'

interface DeviceConsentBodyErrorBoundaryProps {
  readonly resetKey: string
  readonly fallback: (error: unknown) => ReactNode
  readonly children: ReactNode
}

interface DeviceConsentBodyErrorBoundaryState {
  readonly error: unknown
  readonly lastResetKey: string
}

/**
 * Catch a fetch failure from {@link useDeviceConsentQuery} (a
 * `useSuspenseQuery` — its errors are thrown through Suspense, not
 * caught by it) and surface a recoverable error UI *inside* the modal
 * instead of letting it bubble to the app-root `ErrorBoundary`, which
 * would replace the whole SPA with a full-page "Something went wrong"
 * screen for what is, from the user's perspective, a popup that should
 * just close.
 *
 * Resets when `resetKey` changes — the host advancing to a new
 * `userCode` should clear any prior error so the new fetch is allowed
 * to re-suspend.
 */
class DeviceConsentBodyErrorBoundary extends Component<
  DeviceConsentBodyErrorBoundaryProps,
  DeviceConsentBodyErrorBoundaryState
> {
  state: DeviceConsentBodyErrorBoundaryState = { error: null, lastResetKey: this.props.resetKey }

  static getDerivedStateFromError(error: unknown): Partial<DeviceConsentBodyErrorBoundaryState> {
    return { error }
  }

  // The standard `getDerivedStateFromProps` path for resetting an error
  // boundary on prop change: when the host advances to a new `userCode`,
  // discard any prior error so the new fetch is allowed to re-suspend.
  // Doing this in `componentDidUpdate` would lint as `setState` in an
  // update callback; deriving keeps the reset purely declarative.
  static getDerivedStateFromProps(
    props: DeviceConsentBodyErrorBoundaryProps,
    state: DeviceConsentBodyErrorBoundaryState
  ): Partial<DeviceConsentBodyErrorBoundaryState> | null {
    if (props.resetKey !== state.lastResetKey) {
      return { error: null, lastResetKey: props.resetKey }
    }
    return null
  }

  override componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    // No-op: the surrounding modal already conveys what went wrong;
    // the app-root boundary's telemetry path handles cases this
    // boundary doesn't intercept.
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return this.props.fallback(this.state.error)
    }
    return this.props.children
  }
}

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
  // `key={userCode}` is load-bearing: this body stays mounted across userCode
  // changes (the outer Dialog deliberately doesn't unmount), and the form seeds
  // `draft`/`name`/`denied` from `consent` via `useState` initializers that only
  // run on mount. Without the key the previous request's scope draft / device
  // name would carry onto a new head — approving the wrong grant. Keying remounts
  // the whole subtree (ScopePicker's internal state included) per request.
  return <DeviceConsentForm key={userCode} consent={consent} onDone={onDone} />
}

const DeviceConsentErrorFallback = ({
  error,
  onDismiss,
}: {
  readonly error: unknown
  readonly onDismiss: () => void
}): JSX.Element => (
  <>
    <p className="text-body-3" role="alert">
      Couldn't load device consent: {unknownErrorToString(error)}
    </p>
    <button type="button" className="button-2 filled" onClick={onDismiss}>
      Dismiss
    </button>
  </>
)

const DeviceConsentModalHost = (): JSX.Element | null => {
  // The modal lives above the `_auth` route gate so it can float over
  // every route, including the public/code-entry pages. Without an
  // explicit auth check here, a `bridge:DeviceConsentRequested` event
  // arriving before the host has minted a token would drive the
  // suspended `useDeviceConsentQuery` into a tokenless fetch (401 →
  // thrown through Suspense → caught by the body's error boundary
  // below, but only after a needless round-trip). Short-circuiting on
  // an unauthed signal keeps the modal genuinely inert in the
  // pre-auth window.
  const authSubscribable = useAuthStateSubscribable()
  const authSignal = useSubscribable(authSubscribable)
  const activeUserCode = useActiveDeviceUserCode()
  // Local mirror of "what userCode did the user just approve/deny?",
  // tracked so the popup closes immediately on `onDone` without
  // waiting for the host's round-trip (HTTP response → Rust republish
  // → bridge event is observable). Resets to `null` whenever the
  // host's active userCode changes, so the next head — including a
  // hypothetical repeat of the just-handled value — opens the popup
  // again.
  const [handledUserCode, setHandledUserCode] = useState<string | null>(null)

  // Reset handledUserCode when the host's active userCode changes. Adjust
  // state during render (via useLastRendersValue) — a useEffect version
  // trips react/set-state-in-effect and paints the stale "already handled"
  // state for one frame after the host publishes a new active code,
  // briefly showing the closed popup as still closed.
  const prevActiveUserCode = useLastRendersValue(activeUserCode)
  if (activeUserCode !== prevActiveUserCode) {
    setHandledUserCode(null)
  }

  const DeviceConsentErrorFallbackInstance = useMemo(
    () => (error: unknown) => (
      <DeviceConsentErrorFallback
        error={error}
        onDismiss={() => setHandledUserCode(activeUserCode)}
      />
    ),
    [setHandledUserCode, activeUserCode]
  )

  if (!isAuthed(authSignal)) return null

  const isOpen = activeUserCode !== null && activeUserCode !== handledUserCode

  return (
    <Dialog
      open={isOpen}
      title="Device Authorization"
      onClose={() => {
        // × / ESC / backdrop: close without deciding — the request stays
        // pending (still answerable from Settings). Also fires after the
        // controlled `open={false}` close, where marking the userCode
        // handled again is a no-op.
        setHandledUserCode(activeUserCode)
      }}
    >
      {isOpen ? (
        <DeviceConsentBodyErrorBoundary
          resetKey={activeUserCode}
          fallback={DeviceConsentErrorFallbackInstance}
        >
          <Suspense fallback={null}>
            <DeviceConsentDialogBody
              userCode={activeUserCode}
              onDone={() => setHandledUserCode(activeUserCode)}
            />
          </Suspense>
        </DeviceConsentBodyErrorBoundary>
      ) : null}
    </Dialog>
  )
}

export { DeviceConsentModalHost }
