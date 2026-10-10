import {
  appRootRedirectUri,
  authorizeSmartLaunch,
  launchErrorBodyFor,
  launchErrorRedirect,
  type SmartLaunchConfig,
} from '@wildflowerhealthio/fhir-r4-react/smart'

/**
 * Authorize the SMART launch the app root at `launchPageHref` was opened to
 * start, resolving to where the page must go if the launch fails before it
 * leaves.
 *
 * @returns `null` when the authorize redirect is under way (in practice the
 *   promise never settles then — the page navigates away), or the app-root URL
 *   carrying the failure as `?launchError` when `authorizeSmartLaunch` rejects.
 *
 * @remarks
 * fhirclient reads `iss` and `launch` off the page URL itself. The OAuth
 * redirect target is the app's root (`appRootRedirectUri`), derived from
 * `launchPageHref`. A launch that never reaches the authorization server fails
 * here — an unreachable or CORS-blocked `iss`, a server that serves no SMART
 * config, a client id or redirect URI the server does not know. The launch page
 * shows only a loading line, so the failure goes to the app root without the
 * launch, where `SmartAppRoot` hands it to `ConnectMenu` as its
 * `arrivalProblem`.
 */
const authorizeFromLaunchPage = async (
  launch: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'>,
  launchPageHref: string
): Promise<string | null> => {
  const redirectUri = appRootRedirectUri(launchPageHref)
  const search = new URL(launchPageHref).search
  try {
    await authorizeSmartLaunch({ ...launch, redirectUri })
    return null
  } catch (error: unknown) {
    return launchErrorRedirect(redirectUri, launchErrorBodyFor('AuthorizeFailed', error, search))
  }
}

export { authorizeFromLaunchPage }
