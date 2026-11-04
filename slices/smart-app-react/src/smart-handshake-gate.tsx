import {
  type SmartConnection,
  type SmartLaunchConfig,
  type SmartRuntime,
  SmartRuntimeContext,
  smartRuntimeFor,
  useLaunchFailureRedirect,
  useSmartHandshake,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import { ErrorBanner } from '@wildflowerhealthio/react-tundraish'
import { Match } from 'effect'
import { type JSX, useMemo } from 'react'

/** Props for {@link SmartHandshakeGate}. */
interface SmartHandshakeGateProps {
  /**
   * The app's SMART registration, which the callback's code is redeemed as:
   * the same one the app hands `SmartAppRoot`.
   */
  readonly registration: Pick<SmartLaunchConfig, 'clientId' | 'scope'>
  /**
   * The directory the app is served from, as it hands `SmartAppRoot`, so the
   * token request names the redirect URI the launch sent.
   */
  readonly servedDirectory?: string
  /** What the page shows while the token exchange runs. */
  readonly connecting: JSX.Element
  /**
   * The app over the runtime the completed handshake built, where its router
   * is built.
   */
  readonly children: (runtime: SmartRuntime) => JSX.Element
}

/**
 * The app over the runtime built from `connection`, once, with the runtime
 * provided to the tree for `useRunSmart`.
 */
function SignedIn({
  connection,
  children,
}: {
  readonly connection: SmartConnection
  readonly children: (runtime: SmartRuntime) => JSX.Element
}): JSX.Element {
  const runtime = useMemo(() => smartRuntimeFor(connection), [connection])
  return <SmartRuntimeContext value={runtime}>{children(runtime)}</SmartRuntimeContext>
}

/**
 * Completes the SMART handshake, and only then renders the app over the one
 * runtime built from the connection it made: `SmartClient` and the typed
 * FHIR client over `FetchHttpClient`, provided to the tree (`useRunSmart`)
 * and handed to `children`, whose router context carries the same runtime.
 * It is the one place the exchange runs (`useSmartHandshake`).
 *
 * @remarks
 * The app root is the OAuth redirect target, so its URL carries the
 * callback's `code` and `state` until the handshake reads and takes them
 * out. A router matches the URL and redirects `/` to a route, so an app
 * builds its router in `children`, never above this gate: nothing may
 * rewrite a URL the exchange still reads. A failed exchange shows its error
 * here and goes back to the app root (`useLaunchFailureRedirect`), which can
 * offer the connect menu; the code is single-use, so there is nothing to
 * retry.
 */
function SmartHandshakeGate({
  registration,
  servedDirectory,
  connecting,
  children,
}: SmartHandshakeGateProps): JSX.Element {
  const handshake = useSmartHandshake(registration, servedDirectory)
  useLaunchFailureRedirect(handshake)
  return Match.value(handshake).pipe(
    Match.when({ kind: 'error' }, ({ error }) => <ErrorBanner error={error.reason} />),
    Match.when({ kind: 'connecting' }, () => connecting),
    Match.when({ kind: 'ready' }, ({ connection }) => (
      <SignedIn connection={connection}>{children}</SignedIn>
    )),
    Match.exhaustive
  )
}

export { SmartHandshakeGate, type SmartHandshakeGateProps }
