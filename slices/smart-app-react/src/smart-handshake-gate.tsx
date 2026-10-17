import {
  type SmartClient,
  useLaunchFailureRedirect,
  useSmartHandshake,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import { ErrorBanner } from '@wildflowerhealthio/react-tundraish'
import { Match } from 'effect'
import type { JSX } from 'react'

/** Props for {@link SmartHandshakeGate}. */
interface SmartHandshakeGateProps {
  /** What the page shows while the token exchange runs. */
  readonly connecting: JSX.Element
  /** The app over the client the completed handshake handed it, where its router is built. */
  readonly children: (client: SmartClient) => JSX.Element
}

/**
 * Completes the SMART handshake, and only then renders the app over the
 * client it hands out.
 *
 * @remarks
 * The app root is the OAuth redirect target, so its URL carries the
 * callback's `code` and `state` until fhirclient takes them out as the
 * exchange completes. A router matches the URL and redirects `/` to a tab, so
 * an app builds its router in `children`, never above this gate: nothing may
 * rewrite a URL the exchange still reads. A failed exchange shows its error
 * here and goes back to the app root (`useLaunchFailureRedirect`), which can
 * offer the connect menu; the code is single-use, so there is nothing to
 * retry.
 */
function SmartHandshakeGate({ connecting, children }: SmartHandshakeGateProps): JSX.Element {
  const handshake = useSmartHandshake()
  useLaunchFailureRedirect(handshake)
  return Match.value(handshake).pipe(
    Match.when({ kind: 'error' }, ({ error }) => <ErrorBanner error={error} />),
    Match.when({ kind: 'connecting' }, () => connecting),
    Match.when({ kind: 'ready' }, ({ client }) => children(client)),
    Match.exhaustive
  )
}

export { SmartHandshakeGate, type SmartHandshakeGateProps }
