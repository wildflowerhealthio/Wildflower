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
 * Begin the SMART App Launch. Redirects the browser to the EHR's authorize
 * endpoint (discovered from `iss`'s `.well-known/smart-configuration`), so the
 * returned promise usually never resolves — the page navigates away.
 */
const authorizeSmartLaunch = async (config: SmartLaunchConfig): Promise<void> => {
  const FHIR = await loadFhir()
  await FHIR.oauth2.authorize({
    clientId: config.clientId,
    scope: config.scope,
    ...(config.redirectUri === undefined ? {} : { redirectUri: config.redirectUri }),
    ...(config.iss === undefined ? {} : { iss: config.iss }),
  })
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
 * `redirectUri`, so — like {@link authorizeSmartLaunch} — the returned promise
 * usually never resolves because the page navigates away.
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
 * The app root serves both a fresh visit (no query → show the connect menu) and
 * the OAuth redirect target (has a callback → run the app). `code` marks a SMART
 * return and `state` an open-server one; either means there is a handshake to
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

export {
  authorizeOpenServer,
  authorizeSmartLaunch,
  readySmartClient,
  shouldCompleteSmartLaunch,
  type OpenServerConfig,
  type SmartLaunchConfig,
}
