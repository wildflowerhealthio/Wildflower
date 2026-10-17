import {
  type SmartClient,
  useLaunchFailureRedirect,
  useSmartHandshake,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import { ErrorBanner } from '@wildflowerhealthio/react-tundraish'
import { Match } from 'effect'
import { useState, type JSX } from 'react'

import { restoreLandingRoute } from './landing-route.ts'
import type { SmartAppPage } from './smart-app-page.ts'

/** Props for {@link SmartHandshakeGate}. */
interface SmartHandshakeGateProps {
  /** The page the app's router runs over, whose route a launch landed on is restored onto. */
  readonly page: SmartAppPage
  /** What the page shows while the token exchange runs. */
  readonly connecting: JSX.Element
  /** The app over the client the completed handshake handed it, where its router is built. */
  readonly children: (client: SmartClient) => JSX.Element
}

/**
 * Restores the route a launch landed on onto `page`'s history as it first
 * renders, so the router `children` builds reads it.
 *
 * @remarks
 * The restore is one-shot (`restoreLandingRoute` removes its key), so a
 * second call from StrictMode's double render finds nothing and leaves the
 * URL as the first one set it.
 */
function LandingRouteRestored({
  page,
  children,
}: {
  readonly page: SmartAppPage
  readonly children: JSX.Element
}): JSX.Element {
  useState(() => {
    restoreLandingRoute(window.sessionStorage, page)
  })
  return children
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
 *
 * Once ready, and before `children` renders, the route a launch landed on
 * (kept by `authorizeFromLaunchPage`) replaces the app root on `page`'s
 * history, so a deep link such as `/calendar?…` opens that route rather than
 * the default tab.
 */
function SmartHandshakeGate({ page, connecting, children }: SmartHandshakeGateProps): JSX.Element {
  const handshake = useSmartHandshake()
  useLaunchFailureRedirect(handshake)
  return Match.value(handshake).pipe(
    Match.when({ kind: 'error' }, ({ error }) => <ErrorBanner error={error} />),
    Match.when({ kind: 'connecting' }, () => connecting),
    Match.when({ kind: 'ready' }, ({ client }) => (
      <LandingRouteRestored page={page}>{children(client)}</LandingRouteRestored>
    )),
    Match.exhaustive
  )
}

export { SmartHandshakeGate, type SmartHandshakeGateProps }
