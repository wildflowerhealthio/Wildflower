import {
  type SmartConnection,
  SmartHandshake,
  type SmartRuntime,
  SmartRuntimeContext,
  smartRuntimeFor,
  useRedirectToRootOnFailure,
  useSmartHandshake,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import { ErrorBanner } from '@wildflowerhealthio/react-tundraish'
import { Match } from 'effect'
import { type JSX, useEffect, useMemo } from 'react'

import { useSignInLanding } from './sign-in-landing.ts'

/** Props for {@link SmartHandshakeGate}. */
interface SmartHandshakeGateProps {
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
 * provided to the tree for `useRunSmart`. The runtime's services are released
 * when the connection changes or this unmounts.
 */
function SignedIn({
  connection,
  children,
}: {
  readonly connection: SmartConnection
  readonly children: (runtime: SmartRuntime) => JSX.Element
}): JSX.Element {
  const runtime = useMemo(() => smartRuntimeFor(connection), [connection])
  useEffect(
    () => (): void => {
      void runtime.release()
    },
    [runtime]
  )
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
 * here and goes back to the app root (`useRedirectToRootOnFailure`), which can
 * offer the connect menu; the code is single-use, so there is nothing to
 * retry.
 */
function SmartHandshakeGate({ connecting, children }: SmartHandshakeGateProps): JSX.Element {
  const landing = useSignInLanding()
  const handshake = useSmartHandshake(landing)
  useRedirectToRootOnFailure(handshake, landing.appRootRedirectUri)
  const { onSignedIn } = landing
  useEffect(() => {
    if (SmartHandshake.$is('Ready')(handshake)) onSignedIn(handshake.connection)
  }, [handshake, onSignedIn])
  return Match.value(handshake).pipe(
    Match.tagsExhaustive({
      Failed: ({ error }) => <ErrorBanner error={error.reason} />,
      Connecting: () => connecting,
      Ready: ({ connection }) => <SignedIn connection={connection}>{children}</SignedIn>,
    })
  )
}

export { SmartHandshakeGate, type SmartHandshakeGateProps }
