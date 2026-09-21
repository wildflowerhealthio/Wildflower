/**
 * Floats the consent modal over whatever route is currently rendered,
 * driven entirely by the host's `bridge:PendingConsentRequested` push.
 * Inert until the {@link useActivePendingConsent} hook returns a
 * non-null head. Dismissable: the × (or ESC / backdrop) closes the
 * popup *without deciding* — the request stays pending and answerable
 * from Settings (device flow) or the requesting browser's polling page
 * (code flow) until it expires.
 *
 * The head's `kind` picks the branch, mounting the same
 * {@link DeviceConsentForm} / {@link OAuthConsentForm} the standalone
 * routes use rather than a popup-only variant.
 *
 * Mounted exactly once, alongside the router's `<Outlet />` (in
 * `RootShell`), so the popup overlays every route and only one modal
 * can be open at a time.
 */

import type { PendingConsentHead } from 'gatekeeper-core/bridge'
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
  usePreviousDistinctValue,
  useSubscribable,
} from 'react-kitchen-sink'
import { Dialog } from 'react-tundraish'

import { useActivePendingConsent } from '../../active-pending-consent/use-active-pending-consent.ts'
import { useDeviceConsentQuery, useOAuthConsentQuery } from '../../queries/index.ts'
import { OAuthConsentForm } from '../oauth-consent/oauth-consent-form.tsx'
import { DeviceConsentForm } from './device-consent-form.tsx'

/**
 * A stable identity for a head, used as the "already handled" marker and
 * the remount key. Variant-prefixed so a device `userCode` can never
 * collide with an authorization-request id.
 */
const headKey = (head: PendingConsentHead): string =>
  head.kind === 'device' ? `device:${head.userCode}` : `oauth:${head.id}`

/** The dialog title for each flow — the popup names what it is asking about. */
const headTitle = (head: PendingConsentHead): string =>
  head.kind === 'device' ? 'Device Authorization' : 'Authorization Request'

interface PendingConsentBodyErrorBoundaryProps {
  readonly resetKey: string
  readonly fallback: (error: unknown) => ReactNode
  readonly children: ReactNode
}

interface PendingConsentBodyErrorBoundaryState {
  readonly error: unknown
  readonly lastResetKey: string
}

/**
 * Catch a fetch failure from {@link useDeviceConsentQuery} /
 * {@link useOAuthConsentQuery} (both `useSuspenseQuery` — their errors
 * are thrown through Suspense, not caught by it) and surface a
 * recoverable error UI *inside* the modal instead of letting it bubble
 * to the app-root `ErrorBoundary`, which would replace the whole SPA
 * with a full-page "Something went wrong" screen for what is, from the
 * user's perspective, a popup that should just close.
 *
 * Resets when `resetKey` changes — the host advancing to a new head
 * should clear any prior error so the new fetch is allowed to
 * re-suspend.
 */
class PendingConsentBodyErrorBoundary extends Component<
  PendingConsentBodyErrorBoundaryProps,
  PendingConsentBodyErrorBoundaryState
> {
  state: PendingConsentBodyErrorBoundaryState = { error: null, lastResetKey: this.props.resetKey }

  static getDerivedStateFromError(error: unknown): Partial<PendingConsentBodyErrorBoundaryState> {
    return { error }
  }

  // The standard `getDerivedStateFromProps` path for resetting an error
  // boundary on prop change: when the host advances to a new head,
  // discard any prior error so the new fetch is allowed to re-suspend.
  // Doing this in `componentDidUpdate` would lint as `setState` in an
  // update callback; deriving keeps the reset purely declarative.
  static getDerivedStateFromProps(
    props: PendingConsentBodyErrorBoundaryProps,
    state: PendingConsentBodyErrorBoundaryState
  ): Partial<PendingConsentBodyErrorBoundaryState> | null {
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
 * Suspense body for a device-flow head — fetched against the live
 * `userCode`. Inner so the outer modal frame stays open while the fetch
 * resolves; without this, the Suspense fallback would unmount the
 * Dialog and the modal would flicker shut on every head change.
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

/**
 * Suspense body for an authorization-code head — fetched against the
 * parked request's id.
 *
 * The approved result's `redirect` is deliberately dropped here: the
 * viewer of this popup is the Owner on *their* device, not the client
 * that started the flow. The requesting browser is sitting on the
 * polling page and performs the redirect itself once its stream sees
 * `approved`. Navigating this window to the client's callback would
 * send the Owner's app off to the app's `redirect_uri`.
 */
const OAuthConsentDialogBody = ({
  id,
  onDone,
}: {
  readonly id: string
  readonly onDone: () => void
}): JSX.Element => {
  const { data: consent } = useOAuthConsentQuery(id)
  return <OAuthConsentForm consent={consent} onDone={onDone} />
}

const PendingConsentErrorFallback = ({
  error,
  onDismiss,
}: {
  readonly error: unknown
  readonly onDismiss: () => void
}): JSX.Element => (
  <>
    <p className="text-body-3" role="alert">
      Couldn't load the consent request: {unknownErrorToString(error)}
    </p>
    <button type="button" className="button-2 filled" onClick={onDismiss}>
      Dismiss
    </button>
  </>
)

const PendingConsentModalHost = (): JSX.Element | null => {
  // The modal lives above the `_auth` route gate so it can float over
  // every route, including the public/code-entry pages. Without an
  // explicit auth check here, a `bridge:PendingConsentRequested` event
  // arriving before the host has minted a token would drive the
  // suspended consent query into a tokenless fetch (401 →
  // thrown through Suspense → caught by the body's error boundary
  // below, but only after a needless round-trip). Short-circuiting on
  // an unauthed signal keeps the modal genuinely inert in the
  // pre-auth window.
  const authSubscribable = useAuthStateSubscribable()
  const authSignal = useSubscribable(authSubscribable)
  const activeHead = useActivePendingConsent()
  const activeKey = activeHead === null ? null : headKey(activeHead)
  // Local mirror of "which head did the user just approve/deny?",
  // tracked so the popup closes immediately on `onDone` without
  // waiting for the host's round-trip (HTTP response → Rust republish
  // → bridge event is observable). Resets to `null` whenever the
  // host's active head changes, so the next head — including a
  // hypothetical repeat of the just-handled value — opens the popup
  // again.
  const [handledKey, setHandledKey] = useState<string | null>(null)

  // Reset handledKey when the host's active head changes. Adjust
  // state during render (via usePreviousDistinctValue) — a useEffect version
  // trips react/set-state-in-effect and paints the stale "already handled"
  // state for one frame after the host publishes a new active head,
  // briefly showing the closed popup as still closed.
  const prevActiveKey = usePreviousDistinctValue(activeKey)
  if (activeKey !== prevActiveKey) {
    setHandledKey(null)
  }

  const PendingConsentErrorFallbackInstance = useMemo(
    () => (error: unknown) => (
      <PendingConsentErrorFallback error={error} onDismiss={() => setHandledKey(activeKey)} />
    ),
    [setHandledKey, activeKey]
  )

  if (!isAuthed(authSignal)) return null

  const isOpen = activeHead !== null && activeKey !== handledKey

  return (
    <Dialog
      open={isOpen}
      title={activeHead === null ? 'Authorization Request' : headTitle(activeHead)}
      onClose={() => {
        // × / ESC / backdrop: close without deciding — the request stays
        // pending (still answerable from its standalone surface). Also
        // fires after the controlled `open={false}` close, where marking
        // the head handled again is a no-op.
        setHandledKey(activeKey)
      }}
    >
      {isOpen && activeKey !== null ? (
        <PendingConsentBodyErrorBoundary
          resetKey={activeKey}
          fallback={PendingConsentErrorFallbackInstance}
        >
          <Suspense fallback={null}>
            {/*
              `key={activeKey}` is load-bearing: these bodies stay mounted across
              head changes (the outer Dialog deliberately doesn't unmount), and
              each form seeds its draft / name / denied state from `consent` via
              `useState` initializers that only run on mount. Without the key the
              previous request's scope draft would carry onto a new head —
              approving the wrong grant. Keying remounts the whole subtree
              (ScopePicker's internal state included) per request.
            */}
            {activeHead.kind === 'device' ? (
              <DeviceConsentDialogBody
                key={activeKey}
                userCode={activeHead.userCode}
                onDone={() => setHandledKey(activeKey)}
              />
            ) : (
              <OAuthConsentDialogBody
                key={activeKey}
                id={activeHead.id}
                onDone={() => setHandledKey(activeKey)}
              />
            )}
          </Suspense>
        </PendingConsentBodyErrorBoundary>
      ) : null}
    </Dialog>
  )
}

export { PendingConsentModalHost }
