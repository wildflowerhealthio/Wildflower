import {
  type SmartClient,
  useLaunchFailureRedirect,
  useSmartHandshake,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import { ErrorBanner } from '@wildflowerhealthio/react-tundraish'
import { Match } from 'effect'
import { useState, type JSX } from 'react'

import { landOnRoute, restoreLandingRoute } from './landing-route.ts'
import type { SmartAppPage } from './smart-app-page.ts'

/** Props for {@link SmartHandshakeGate}. */
interface SmartHandshakeGateProps {
  /** The page the app's router runs over, whose route a launch landed on is restored onto. */
  readonly page: SmartAppPage
  /** What the page shows while the token exchange runs. */
  readonly connecting: JSX.Element
  /**
   * The app's route a completed launch opens when it kept no route of its
   * own (a launch at the app root, a standalone connect), given the client
   * the handshake handed out: e.g. `launchPatientRoute`, the launch's
   * patient or the picker. Omitted, the page stays on the app root.
   */
  readonly landsOn?: (client: SmartClient) => string
  /** The app over the client the completed handshake handed it, where its router is built. */
  readonly children: (client: SmartClient) => JSX.Element
}

/**
 * Opens the route a launch landed on, or else the app's `landsOn` route, on
 * `page`'s history as it first renders, replacing the app root, so the
 * router `children` builds reads it.
 *
 * @remarks
 * `landOnRoute` acts only on the bare app root, so it gives way to a
 * restored route. The restore is one-shot (`restoreLandingRoute` removes its
 * key), so a second call from StrictMode's double render finds nothing to do
 * and leaves the URL as the first one set it.
 */
function LaunchLandingOpened({
  page,
  landsOn,
  children,
}: {
  readonly page: SmartAppPage
  readonly landsOn: string | undefined
  readonly children: JSX.Element
}): JSX.Element {
  useState(() => {
    restoreLandingRoute(window.sessionStorage, page)
    if (landsOn !== undefined) landOnRoute(page, landsOn)
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
 * history, so a deep link such as `/patients/123/plan?…` opens that route;
 * with none kept, `landsOn`'s route does. One history entry either way.
 */
function SmartHandshakeGate({
  page,
  connecting,
  landsOn,
  children,
}: SmartHandshakeGateProps): JSX.Element {
  const handshake = useSmartHandshake()
  useLaunchFailureRedirect(handshake)
  return Match.value(handshake).pipe(
    Match.when({ kind: 'error' }, ({ error }) => <ErrorBanner error={error} />),
    Match.when({ kind: 'connecting' }, () => connecting),
    Match.when({ kind: 'ready' }, ({ client }) => (
      <LaunchLandingOpened page={page} landsOn={landsOn?.(client)}>
        {children(client)}
      </LaunchLandingOpened>
    )),
    Match.exhaustive
  )
}

export { SmartHandshakeGate, type SmartHandshakeGateProps }
