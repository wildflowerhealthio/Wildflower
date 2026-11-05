import {
  appRootRedirectUri,
  decodeFhirBaseUrl,
  launchErrorBodyFor,
  launchErrorRedirect,
  redirectToSignIn,
  smartSignInLayer,
  type RootArrival,
  type SmartRegistration,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import { type Data, Effect, Option } from 'effect'

import { saveReturnRoute } from './return-route.ts'
import { signInProblem } from './sign-in-problem.ts'

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
 * @returns `None` once the page has been sent away to sign in, or the
 *   app-root URL carrying the failure as `?launchError` when it cannot be.
 *
 * @remarks
 * The launch is the page URL's `iss`, with the EHR's `launch` for an EHR
 * launch. `redirectToSignIn` probes the `iss` as the connect menu probes a
 * picked server: a SMART server is signed in to at its authorization server,
 * and an open one (no SMART configuration, or one naming no
 * `authorization_endpoint`) by a self-addressed sign-in. The OAuth redirect
 * target is the app's root (`appRootRedirectUri`), derived from
 * `launchPageHref` and `basepath`, whichever route of the app the launch
 * opened. A launch that cannot leave fails here — an unreachable or
 * CORS-blocked `iss`, an advertised endpoint this page will not use, a
 * storage that will not retain the sign-in request — with the connect menu's
 * wording (`signInProblem`). The launch page shows only a loading line, so the
 * failure goes to the app root without the launch, where `SmartAppRoot` hands
 * it to `ConnectMenu` as its `arrivalProblem`.
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
    Effect.provide(smartSignInLayer(window)),
    Effect.match({
      onFailure: (failure) => Option.some(failure.reason),
      onSuccess: (support) => Option.fromNullable(signInProblem(launch.iss, support)),
    }),
    Effect.map(
      Option.map((reason) =>
        launchErrorRedirect(redirectUri, launchErrorBodyFor('AuthorizeFailed', { reason }, search))
      )
    ),
    Effect.runPromise
  )
}

export { redirectForLaunchRequest }
