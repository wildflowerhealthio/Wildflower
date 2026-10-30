import {
  appRootRedirectUri,
  arrivingSmartLaunchFrom,
  authorizeSmartLaunch,
  launchErrorBodyFor,
  launchErrorRedirect,
  type SmartLaunchConfig,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import { Option } from 'effect'

import { saveReturnRoute } from './return-route.ts'

/**
 * Authorize the SMART launch the page at `launchPageHref` was opened to
 * start, resolving to where the page must go if the launch fails before it
 * leaves.
 *
 * @param servedDirectory - The directory the app is served from (a routed
 *   app's basepath), as `appRootRedirectUri` takes it; omitted, the page's
 *   own directory.
 * @returns `null` once the page has been sent to the authorization server,
 *   or the app-root URL carrying the failure as `?launchError` when the page
 *   carries no launch or `authorizeSmartLaunch` rejects.
 *
 * @remarks
 * The launch is the page URL's `iss`, with the EHR's `launch` for an EHR
 * launch (`arrivingSmartLaunchFrom`). The OAuth
 * redirect target is the app's root (`appRootRedirectUri`), derived from
 * `launchPageHref` and `servedDirectory`, whichever route of the app the launch
 * opened. A launch that never reaches the authorization server fails
 * here — an unreachable or CORS-blocked `iss`, a server that serves no SMART
 * config, an advertised authorization endpoint `authorizeSmartLaunch` will not
 * send the page to, a client id or redirect URI the server does not know. The launch page
 * shows only a loading line, so the failure goes to the app root without the
 * launch, where `SmartAppRoot` hands it to `ConnectMenu` as its
 * `arrivalProblem`.
 *
 * The route the launch page sits on (a deep link such as `/calendar?…`, its
 * launch parameters left out) is saved in `sessionStorage` before the page
 * leaves (`saveReturnRoute`), since the callback comes back to the app root,
 * whose redirect (`appRootRedirect`) returns to it.
 */
const authorizeFromLaunchPage = async (
  registration: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'>,
  launchPageHref: string,
  servedDirectory?: string
): Promise<string | null> => {
  const redirectUri = appRootRedirectUri(launchPageHref, servedDirectory)
  const search = new URL(launchPageHref).search
  saveReturnRoute(window.sessionStorage, launchPageHref, servedDirectory)
  try {
    const arrivingLaunch = Option.getOrThrowWith(
      arrivingSmartLaunchFrom(search),
      () => new Error('The page carries no SMART launch to start.')
    )
    await authorizeSmartLaunch(
      { ...registration, redirectUri, iss: arrivingLaunch.iss },
      arrivingLaunch.launch
    )
    return null
  } catch (error: unknown) {
    return launchErrorRedirect(redirectUri, launchErrorBodyFor('AuthorizeFailed', error, search))
  }
}

export { authorizeFromLaunchPage }
