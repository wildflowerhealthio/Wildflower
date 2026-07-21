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
 * Complete the SMART handshake on the redirect page: exchanges the auth code
 * for tokens and resolves to a ready {@link Client}.
 */
const readySmartClient = async (): Promise<Client> => {
  const FHIR = await loadFhir()
  return FHIR.oauth2.ready()
}

export { authorizeSmartLaunch, readySmartClient, type SmartLaunchConfig }
