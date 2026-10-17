import {
  appRootRedirectUri,
  authorizeSmartLaunch,
  launchErrorBodyFor,
  launchErrorRedirect,
  type SmartLaunchConfig,
} from '@wildflowerhealthio/fhir-r4-react/smart'

import { forgetLandingRoute, saveLandingRoute } from './landing-route.ts'

/**
 * Authorize the SMART launch the app root at `launchPageHref` was opened to
 * start, resolving to where the page must go if the launch fails before it
 * leaves.
 *
 * @returns `null` once the page has been sent to the authorization server,
 *   or the app-root URL carrying the failure as `?launchError` when
 *   `authorizeSmartLaunch` rejects.
 *
 * @remarks
 * fhirclient reads `iss` and `launch` off the page URL itself. The OAuth
 * redirect target is the app's root (`appRootRedirectUri`), derived from
 * `launchPageHref`. A launch that never reaches the authorization server fails
 * here — an unreachable or CORS-blocked `iss`, a server that serves no SMART
 * config, an advertised authorization endpoint `authorizeSmartLaunch` will not
 * send the page to, a client id or redirect URI the server does not know. The launch page
 * shows only a loading line, so the failure goes to the app root without the
 * launch, where `SmartAppRoot` hands it to `ConnectMenu` as its
 * `arrivalProblem`.
 *
 * The route the launch page sits on (a deep link such as `/calendar?…`, its
 * launch parameters left out) is kept in `sessionStorage` before the page
 * leaves, since the callback comes back to the app root;
 * `SmartHandshakeGate` restores it once the exchange completes. A launch that
 * fails here drops it again.
 */
const authorizeFromLaunchPage = async (
  launch: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'>,
  launchPageHref: string
): Promise<string | null> => {
  const redirectUri = appRootRedirectUri(launchPageHref)
  const search = new URL(launchPageHref).search
  saveLandingRoute(window.sessionStorage, launchPageHref)
  try {
    await authorizeSmartLaunch({ ...launch, redirectUri })
    return null
  } catch (error: unknown) {
    forgetLandingRoute(window.sessionStorage)
    return launchErrorRedirect(redirectUri, launchErrorBodyFor('AuthorizeFailed', error, search))
  }
}

export { authorizeFromLaunchPage }
