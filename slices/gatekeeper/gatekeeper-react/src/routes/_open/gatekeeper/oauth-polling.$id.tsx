// This file route must keep its `export const Route` (the tanstackRouter
// plugin keys off it), and `PendingView` is exported separately as a
// unit-test seam — so a consolidated single export isn't possible here.
import { createFileRoute, Navigate } from '@tanstack/react-router'
import {
  type AuthorizationStatus,
  type AuthorizationStatusError,
  pollAuthorizationStatus,
} from 'gatekeeper-core/clients'
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
  cn,
  isAuthed,
  useAuthStateSubscribable,
  useStreamWithDefault,
  useSubscribable,
} from 'react-kitchen-sink'
import { AsyncErrorView } from 'react-tundraish'

import { Match, Stream } from 'effect'
import { useOAuthConsentQuery } from '../../../queries/index.ts'
import type { OAuthConsentResult } from '../../../queries/index.ts'
import { useGatekeeperRuntimeLayer } from '../../../router-context.ts'
import { OAuthConsentForm } from '../../../screens/oauth-consent/oauth-consent-form.tsx'
import pageLayout from '../../../styles/page-layout.module.css'
import styles from './oauth-polling.module.css'

const ErrorComponent = (error: unknown): JSX.Element => (
  <div className={styles['poll']}>
    <AsyncErrorView
      error={error}
      title="Authorization Error"
      titleClassName={pageLayout['poll-declined']}
    />
  </div>
)

/**
 * SPA route that subscribes to `pollAuthorizationStatus(id)` and renders
 * the latest emission. This is a long-lived `Stream` (it emits `pending`
 * heartbeats until a terminal status), not a one-shot read, so it runs
 * through `react-kitchen-sink`'s generic `useStream` against the
 * composed `runtimeLayer` from router context — NOT a one-shot TanStack
 * query. The polling endpoint is public, and the tokenless client adds
 * no `Authorization` header (auth, where needed, rides the cookie).
 */
function OAuthPollingScreen({ id }: { readonly id: string }): JSX.Element {
  const runtimeLayer = useGatekeeperRuntimeLayer()
  const stream = useMemo(
    () =>
      pollAuthorizationStatus(id).pipe(
        // Fold every typed error the poll can fail with into a terminal
        // `error` status, so the stream never rejects and `PollingResult`'s
        // `error` branch renders the message. Exhaustive over the union: the
        // two declared endpoint errors (discriminated on `error`) plus the
        // framework transport/decode errors (discriminated on `_tag`).
        // Collapse consecutive `pending` heartbeats. The poll re-emits a
        // fresh `{ status: 'pending' }` object every 1.5s; each distinct
        // reference would otherwise flow through `useStreamWithDefault`'s
        // unconditional `setState` and re-render the whole inline consent
        // subtree (`PendingView` → `OAuthConsentForm` → `ScopePicker`) on
        // every tick. Terminal statuses emit exactly once (the poll's
        // `takeUntil`), so `pending` is the only value that ever repeats.
        Stream.changesWith((a, b) => a.status === 'pending' && b.status === 'pending'),
        Stream.catchAll(
          Match.type<AuthorizationStatusError>().pipe(
            Match.withReturnType<Stream.Stream<AuthorizationStatus, never>>(),
            Match.when({ error: 'AuthorizationRequestNotFound' }, ({ id: notFoundId }) =>
              Stream.succeed({
                status: 'error',
                message: `Authorization request "${notFoundId}" was not found.`,
              })
            ),
            Match.when({ error: 'server_error' }, ({ error_description }) =>
              Stream.succeed({
                status: 'error',
                message: error_description ?? 'The authorization server encountered an error.',
              })
            ),
            Match.tag('RequestError', () =>
              Stream.succeed({
                status: 'error',
                message: 'Could not reach the authorization server.',
              })
            ),
            Match.tag('ResponseError', () =>
              Stream.succeed({
                status: 'error',
                message: 'The authorization server returned an unexpected response.',
              })
            ),
            Match.tag('ParseError', 'HttpApiDecodeError', () =>
              Stream.succeed({
                status: 'error',
                message: 'The authorization status response could not be parsed.',
              })
            ),
            Match.exhaustive
          )
        ),
        Stream.provideLayer(runtimeLayer)
      ),
    [id, runtimeLayer]
  )

  // `AuthorizationStatus` (the server contract from gatekeeper-core) covers
  // the four terminal/heartbeat arms; the only local addition is the
  // `initial-loading` default this hook renders before the first emission.
  const status = useStreamWithDefault<AuthorizationStatus | { readonly status: 'initial-loading' }>(
    stream,
    useMemo(() => ({ status: 'initial-loading' }), [])
  )

  return Match.value(status).pipe(
    Match.when({ status: 'initial-loading' }, () => <PollingSpinner />),
    Match.when({ status: 'pending' }, () => <PendingView id={id} />),
    Match.when({ status: 'approved' }, ({ redirect }) => {
      return <Navigate to={redirect} />
    }),
    Match.when({ status: 'denied' }, () => <DeclinedView />),
    Match.when({ status: 'error' }, ({ message }) => ErrorComponent(message)),
    Match.exhaustive
  )
}

/** The declined terminal copy, shared by `PollingResult`'s `denied` branch and
 * `InlineConsent` (a user declining inline sees the same message the stream
 * would show on observing the denial). */
const DeclinedView = (): JSX.Element => (
  <div className={styles['poll']}>
    <h1 className={cn(pageLayout['poll-declined'], 'text-heading-6')}>Request Declined</h1>
    <p className="text-body-2">The authorization request was declined.</p>
  </div>
)

/**
 * The pending-heartbeat view. When the viewer is already authenticated,
 * they are almost certainly the person who initiated this authorization
 * from this very browser, so let them approve it inline instead of
 * bouncing to their phone. An unauthenticated viewer keeps the spinner —
 * they can only approve out-of-band on a signed-in device.
 *
 * Exported as a test seam: the auth branch is unit-tested directly,
 * without the full stream subscription.
 */
const PendingView = ({ id }: { readonly id: string }): JSX.Element => {
  // Same idiom as the device-consent modal host: read the published auth
  // signal and gate on `isAuthed`. Unauthed viewers can't consent inline
  // (the consent query needs the cookie), so they get the spinner.
  const authSignal = useSubscribable(useAuthStateSubscribable())
  if (!isAuthed(authSignal)) return <PollingSpinner />

  return (
    <QuietErrorBoundary fallback={<PollingSpinner />}>
      <Suspense fallback={<PollingSpinner />}>
        <InlineConsent id={id} />
      </Suspense>
    </QuietErrorBoundary>
  )
}

interface QuietErrorBoundaryProps {
  readonly fallback: ReactNode
  readonly children: ReactNode
}

interface QuietErrorBoundaryState {
  readonly errored: boolean
}

/**
 * Swallows any error thrown by the suspended {@link InlineConsent}
 * subtree and quietly falls back to the spinner instead.
 *
 * This is *deliberate degradation*, not error hiding. On this public
 * polling page the only way the consent query throws is a stale
 * `wf_auth_exp` cookie: it makes the page believe the viewer is authed,
 * so `PendingView` mounts `InlineConsent`, whose Suspense query then 401s
 * and throws (issue #256). But a viewer whose cookie has actually expired
 * is, for consent purposes, unauthenticated — so the page must behave
 * exactly as it does for an unauthenticated viewer: show the normal
 * "Waiting for Approval" spinner and keep the polling stream mounted so a
 * phone-side approval still advances the page. Surfacing the 401 as an
 * error UI here would be wrong.
 *
 * No reset path (unlike `DeviceConsentBodyErrorBoundary`): the route's
 * `id` is fixed for the page's lifetime, so there is nothing to recover
 * to — the fallback is terminal for this render.
 */
class QuietErrorBoundary extends Component<QuietErrorBoundaryProps, QuietErrorBoundaryState> {
  state: QuietErrorBoundaryState = { errored: false }

  static getDerivedStateFromError(): QuietErrorBoundaryState {
    return { errored: true }
  }

  override componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    // Intentionally silent — the fallback spinner is the intended UX for
    // the only error that reaches here (a stale-cookie 401). See the
    // class doc comment.
  }

  override render(): ReactNode {
    return this.state.errored ? this.props.fallback : this.props.children
  }
}

/**
 * The inline consent form for an already-authenticated viewer. Reads the
 * consent through the Suspense-backed {@link useOAuthConsentQuery} — only
 * ever mounted under `PendingView`'s authed branch — and renders the same
 * {@link OAuthConsentForm} the `_auth` consent route uses.
 */
const InlineConsent = ({ id }: { readonly id: string }): JSX.Element => {
  const { data: consent } = useOAuthConsentQuery(id)
  const [declined, setDeclined] = useState(false)

  if (declined) return <DeclinedView />

  const handleDone = (result: OAuthConsentResult): void => {
    switch (result.status) {
      case 'approved':
        if (result.redirect !== undefined) {
          // This viewer *is* the requesting client, so send it straight to
          // the callback. Benign race: the polling stream may also observe
          // `approved` and fire its own `replace` — to the same URL.
          window.location.replace(result.redirect)
        }
        // No redirect (e.g. device-flow approval): nothing to navigate to
        // here. The polling stream will observe `approved` on its next tick
        // and `PollingResult`'s effect performs the redirect.
        return
      case 'denied':
        setDeclined(true)
        return
      case 'error':
        // The form surfaces an `error` result inline (role=alert) and never
        // calls `onDone` with it — handled here only for exhaustiveness.
        return
    }
  }

  return (
    <div className={styles['consent']}>
      <OAuthConsentForm consent={consent} onDone={handleDone} />
    </div>
  )
}

const PollingSpinner = (): JSX.Element => (
  <div className={styles['poll']}>
    <div className={styles['poll-spinner']} />
    <h1 className="text-heading-6">Waiting for Approval</h1>
    <p className="text-body-2">Please approve this request on your device.</p>
  </div>
)

/**
 * The `/gatekeeper/oauth-polling/$id` file route. Reads the typed `$id`
 * path param from the generated route via `Route.useParams()` and hands it
 * to the screen as a prop.
 */
function OAuthPollingRoute(): JSX.Element {
  const { id } = Route.useParams()
  return <OAuthPollingScreen id={id} />
}

const Route = createFileRoute('/_open/gatekeeper/oauth-polling/$id')({
  component: OAuthPollingRoute,
})

export { Route, PendingView }
