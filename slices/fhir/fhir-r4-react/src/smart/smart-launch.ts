import {
  arrivingSmartLaunchFrom,
  endpointUrlFrom,
  type ArrivingSmartLaunch,
} from '@wildflowerhealthio/authorization-core/smart-client'
import { Either } from 'effect'
import type Client from 'fhirclient/lib/Client'
import type { fhirclient } from 'fhirclient/lib/types'

/** The slice of fhirclient's `module.exports` this module actually uses. */
interface FhirClientModule {
  readonly oauth2: fhirclient.SMART
}

/**
 * Configuration for a SMART App Launch handshake. `iss` (the FHIR server base,
 * the "issuer") and the opaque `launch` token are normally read from the launch
 * URL by fhirclient; pass `iss` only for a standalone launch.
 */
interface SmartLaunchConfig {
  readonly clientId: string
  readonly scope: string
  readonly redirectUri?: string
  readonly iss?: string
}

/**
 * fhirclient is a CommonJS (`export =`) package whose browser build is selected
 * via its `browser` field. Under this slice's `verbatimModuleSyntax` a static
 * default import of an `export =` module is disallowed, so we load it lazily
 * with a dynamic import (which also code-splits it out of the main chunk) and
 * read `.default` — the CommonJS `module.exports` object — off the namespace.
 */
const loadFhir = async (): Promise<FhirClientModule> => (await import('fhirclient')).default

/**
 * Begin the SMART App Launch. Sends the browser to the EHR's authorize
 * endpoint (discovered from `iss`'s `.well-known/smart-configuration`), so the
 * page usually navigates away once the returned promise resolves.
 *
 * @remarks
 * fhirclient builds the authorize URL from whatever endpoint the server
 * advertises and checks only that one is named. So it is asked for the URL
 * (`noRedirect`), with its launch state already stored, and this function
 * makes the navigation itself, after `endpointUrlFrom` accepts the URL for
 * this page (`pageIsSecure` read from `window.location` at the call). A
 * `javascript:` URL, one carrying userinfo or a fragment, and plain http off
 * loopback from an https page are each refused: the promise rejects naming
 * the reason, and the page stays where it is.
 *
 * The check is on the URL fhirclient navigates to, not on a configuration
 * fetched beforehand, because fhirclient fetches the configuration again
 * itself. When the server names no authorize endpoint, fhirclient's URL is
 * the app's own redirect target, and it goes through the same check.
 */
const authorizeSmartLaunch = async (config: SmartLaunchConfig): Promise<void> => {
  const FHIR = await loadFhir()
  const authorizeUrl = await FHIR.oauth2.authorize({
    clientId: config.clientId,
    scope: config.scope,
    ...(config.redirectUri === undefined ? {} : { redirectUri: config.redirectUri }),
    ...(config.iss === undefined ? {} : { iss: config.iss }),
    noRedirect: true,
  })
  if (typeof authorizeUrl !== 'string') {
    throw new Error('fhirclient returned no authorize URL to navigate to.')
  }
  const usableAuthorizeUrl = endpointUrlFrom(authorizeUrl, {
    pageIsSecure: window.location.protocol === 'https:',
  })
  if (Either.isLeft(usableAuthorizeUrl)) {
    throw new Error(
      `The server’s authorization endpoint is not one this app will go to. ${usableAuthorizeUrl.left.reason}`
    )
  }
  window.location.assign(usableAuthorizeUrl.right)
}

/**
 * Configuration for connecting to an **open** FHIR server — one whose
 * `.well-known/smart-configuration` names no authorization endpoint (or serves
 * no config at all). There is no OAuth handshake: fhirclient redirects straight
 * to the redirect target, which `readySmartClient` then completes into a client
 * with `state.serverUrl` set and no `tokenResponse.access_token`.
 */
interface OpenServerConfig {
  /** The FHIR server base to connect to, used with no `Authorization` header. */
  readonly fhirServiceUrl: string
  readonly redirectUri: string
}

/**
 * Begin an open-server connection. `oauth2.authorize({ fhirServiceUrl })` skips
 * discovery and the code/token exchange entirely and redirects straight to
 * `redirectUri`, so the returned promise usually never resolves because the
 * page navigates away. fhirclient navigates itself here: the URL is the app's
 * own redirect target, not one a server advertised.
 */
const authorizeOpenServer = async (config: OpenServerConfig): Promise<void> => {
  const FHIR = await loadFhir()
  await FHIR.oauth2.authorize({
    fhirServiceUrl: config.fhirServiceUrl,
    redirectUri: config.redirectUri,
  })
}

/**
 * Complete the SMART handshake on the redirect page: exchanges the auth code
 * for tokens and resolves to a ready {@link Client}.
 */
const readySmartClient = async (): Promise<Client> => {
  const FHIR = await loadFhir()
  return FHIR.oauth2.ready()
}

/**
 * Whether `search` is a SMART/OAuth redirect the app should complete with
 * {@link readySmartClient} (rather than showing the connect menu).
 *
 * @remarks
 * The app root serves a fresh visit (no query → show the connect menu), a
 * launch it was opened to start ({@link arrivingSmartLaunchFrom}), and the OAuth
 * redirect target (has a callback → run the app). `code` marks a SMART return
 * and `state` an open-server one; either means there is a handshake to
 * complete.
 *
 * An `error=…` return is excluded deliberately: an OAuth error still carries
 * `state`, so without this the app would try to complete a handshake that failed
 * (a denied or expired authorization). Excluding it routes those back to the
 * connect menu to retry instead.
 *
 * `search` is a parameter (default `window.location.search`) so the decision can
 * be exercised without a window — the same transport-is-a-parameter style as the
 * rest of `smart/`.
 */
const shouldCompleteSmartLaunch = (search: string = window.location.search): boolean => {
  const params = new URLSearchParams(search)
  if (params.has('error')) return false
  return params.has('code') || params.has('state')
}

/**
 * The OAuth redirect URI for a SMART app, from the URL of any of its pages:
 * the app's served directory, `appDirectory`, on `href`'s origin, without
 * the page's query or fragment. Without `appDirectory` it is `href`'s own
 * directory (`new URL('.', href)`), right for an app whose every page sits at
 * its root.
 *
 * @param href - The page's URL.
 * @param appDirectory - The directory the app is served from, as an absolute,
 *   slash-suffixed path (a routed app's basepath, e.g. `/pr-7/`). A routed
 *   app passes it, since a launch can open one of its deep routes
 *   (`/patients/123/today?iss=…`), whose own directory is no registered
 *   redirect URI.
 *
 * @remarks
 * The app root, which serves `index.html`, is the one redirect target for every
 * way in: a launch it was opened to start ({@link arrivingSmartLaunchFrom}), a
 * standalone launch from the connect menu, and a failed launch sent back with
 * `launchErrorRedirect`. It is
 * the page that completes the handshake ({@link readySmartClient}) and the page
 * that can show a failure, so a launch always returns there. Every such page
 * derives the same value, and the value is the same on the way out and on the
 * callback whatever query the page carries.
 *
 * Derived from the page URL rather than configured, so the bundle works at
 * whatever origin and path it is served from. It is not `authorization-core`'s
 * `redirectUriForPage`: there is no plaintext screen, because the registered
 * client's redirect URIs decide where a launch may return, and any userinfo the
 * page URL carries is kept.
 */
const appRootRedirectUri = (href: string, appDirectory = '.'): string =>
  new URL(appDirectory, href).href

export {
  appRootRedirectUri,
  /**
   * Re-exported from `authorization-core/smart-client`, like `normalizeServerUrl`:
   * the launch a page's URL asks it to start, which the app root reads to
   * authorize a launch rather than show the connect menu. The pages that sign
   * in with `authorization-core` read launches the same way without depending on
   * this package.
   */
  arrivingSmartLaunchFrom,
  authorizeOpenServer,
  authorizeSmartLaunch,
  readySmartClient,
  shouldCompleteSmartLaunch,
  type ArrivingSmartLaunch,
  type OpenServerConfig,
  type SmartLaunchConfig,
}
