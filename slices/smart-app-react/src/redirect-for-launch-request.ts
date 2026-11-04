import {
  appRootRedirectUri,
  decodeFhirBaseUrl,
  launchErrorBodyFor,
  launchErrorRedirect,
  redirectToSignIn,
  type RootArrival,
  type SmartRegistration,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import { type Data, Effect, Option } from 'effect'

import { saveReturnRoute } from './return-route.ts'

/**
 * Sign in for `launchRequest`, the SMART launch the page at `launchPageHref`
 * was opened to start, resolving to where the page must go if the launch
 * fails before it leaves.
 *
 * @param registration - The app's SMART registration
 * @param launchRequest - The launch the page's URL carries, as the app root
 *   read it on arrival
 * @param launchPageHref - The launch page's URL
 * @param basepath - The directory the app is served from
 *   (`SmartAppPage.basepath`), as `appRootRedirectUri` takes it; omitted, the
 *   page's own directory.
 * @returns `None` once the page has been sent to the authorization server,
 *   or the app-root URL carrying the failure as `?launchError` when
 *   `redirectToSignIn` fails.
 *
 * @remarks
 * The launch is the page URL's `iss`, with the EHR's `launch` for an EHR
 * launch. The OAuth redirect target is the app's root (`appRootRedirectUri`),
 * derived from `launchPageHref` and `basepath`, whichever route of the app the
 * launch opened. A launch that never reaches the authorization server fails
 * here — an unreachable or CORS-blocked `iss`, a server that serves no SMART
 * config, an advertised authorization endpoint `redirectToSignIn` will not
 * send the page to, a client id or redirect URI the server does not know. The
 * launch page shows only a loading line, so the failure goes to the app root
 * without the launch, where `SmartAppRoot` hands it to `ConnectMenu` as its
 * `arrivalProblem`.
 *
 * The route the launch page sits on (a deep link such as `/calendar?…`, its
 * launch parameters left out) is saved in `sessionStorage` before the page
 * leaves (`saveReturnRoute`), since the callback comes back to the app root,
 * whose redirect (`appRootRedirect`) returns to it.
 */
const redirectForLaunchRequest = (
  registration: SmartRegistration,
  { launch }: Data.TaggedEnum.Value<RootArrival, 'LaunchRequest'>,
  launchPageHref: string,
  basepath?: string
): Promise<Option.Option<string>> => {
  const redirectUri = appRootRedirectUri(launchPageHref, basepath)
  const search = new URL(launchPageHref).search
  saveReturnRoute(window.sessionStorage, launchPageHref, basepath)
  return redirectToSignIn(
    { ...registration, redirectUri, fhirBaseUrl: decodeFhirBaseUrl(launch.iss) },
    launch.launch
  ).pipe(
    Effect.match({
      onFailure: (failure) =>
        Option.some(
          launchErrorRedirect(redirectUri, launchErrorBodyFor('AuthorizeFailed', failure, search))
        ),
      onSuccess: () => Option.none(),
    }),
    Effect.runPromise
  )
}

export { redirectForLaunchRequest }
