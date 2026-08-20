import { authorizeOpenServer, authorizeSmartLaunch } from './smart-launch.ts'

/**
 * What probing a FHIR server's `.well-known/smart-configuration` told us about
 * how to connect to it.
 *
 * @remarks
 * Three outcomes, not two, and the third is deliberate. A CORS-blocked probe
 * rejects identically to a down server — the browser gives no way to tell them
 * apart — so a rejected probe is `unreachable`, surfaced to the user, **never**
 * silently treated as `open`. Treating it as open would fire unauthenticated
 * resource reads at a server that may well require auth, producing misleading
 * 401s. A real HTTP answer (even a 404, or non-JSON) is `open`: the server
 * responded, it just has no SMART config.
 */
type SmartSupport =
  | { readonly kind: 'smart' } // config found, has authorization_endpoint
  | { readonly kind: 'open' } // HTTP non-ok, or JSON without authorization_endpoint
  | { readonly kind: 'unreachable'; readonly message: string } // fetch rejected (network/CORS — indistinguishable)

/** The inputs a standalone launch needs: the server, and the app's own client. */
interface StandaloneLaunchConfig {
  /** The FHIR server base the user picked — used verbatim as the base URL. */
  readonly iss: string
  readonly clientId: string
  readonly scope: string
  readonly redirectUri: string
}

/**
 * True when `config` is an object carrying a string `authorization_endpoint` —
 * the one field that distinguishes a SMART server from an open one.
 *
 * @remarks
 * The `in` narrowing plus a `typeof` guard reads the field off `unknown` without
 * a cast: an object that lacks the key, or whose value is not a string, is not a
 * SMART server as far as the standalone flow is concerned.
 */
const hasAuthorizationEndpoint = (config: unknown): boolean => {
  if (typeof config !== 'object' || config === null) return false
  if (!('authorization_endpoint' in config)) return false
  return typeof config.authorization_endpoint === 'string'
}

/**
 * Probe `{iss}/.well-known/smart-configuration` to decide how to connect.
 *
 * @remarks
 * `fetchFn` is a parameter (default `globalThis.fetch`) so a test can drive the
 * three outcomes over a stub without a real wire — the same transport-is-a-
 * parameter philosophy as the SMART runtime's `HttpClient`.
 *
 * @param iss - The FHIR server base (trailing slashes are trimmed before the
 *   well-known path is appended)
 * @param fetchFn - The `fetch` to probe with; defaults to `globalThis.fetch`
 */
const detectSmartSupport = async (
  iss: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<SmartSupport> => {
  const base = iss.replace(/\/+$/u, '')
  let response: Response
  try {
    response = await fetchFn(`${base}/.well-known/smart-configuration`, {
      headers: { Accept: 'application/json' },
    })
  } catch (error) {
    // A rejected fetch is network-or-CORS and the two are indistinguishable
    // here — surface it, never degrade to `open`.
    return { kind: 'unreachable', message: error instanceof Error ? error.message : String(error) }
  }
  // A real HTTP answer that isn't ok (404, 500, …) is a server with no SMART
  // config → open. Only a config that names an authorization endpoint is SMART.
  if (!response.ok) return { kind: 'open' }
  let config: unknown
  try {
    config = await response.json()
  } catch {
    return { kind: 'open' }
  }
  return hasAuthorizationEndpoint(config) ? { kind: 'smart' } : { kind: 'open' }
}

/**
 * Run a standalone SMART App Launch against `config.iss`: probe, then take the
 * SMART OAuth path, the open (no-auth) path, or neither.
 *
 * @remarks
 * On `smart`/`open` the browser redirects away (fhirclient's `authorize` sends
 * it to the provider or straight to the redirect target), so the returned
 * promise usually never resolves. On `unreachable` there is no redirect — the
 * `SmartSupport` is returned so the caller can render the error and offer a
 * retry.
 *
 * @param config - The picked server plus the app's client id, scope, and
 *   redirect target
 * @param fetchFn - The `fetch` the probe uses; defaults to `globalThis.fetch`
 * @returns The probe outcome. `smart`/`open` are returned only in the (unusual)
 *   case the redirect does not navigate the page away; `unreachable` always is.
 */
const startStandaloneLaunch = async (
  config: StandaloneLaunchConfig,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<SmartSupport> => {
  const support = await detectSmartSupport(config.iss, fetchFn)
  if (support.kind === 'smart') {
    await authorizeSmartLaunch({
      clientId: config.clientId,
      scope: config.scope,
      redirectUri: config.redirectUri,
      iss: config.iss,
    })
  } else if (support.kind === 'open') {
    await authorizeOpenServer({ fhirServiceUrl: config.iss, redirectUri: config.redirectUri })
  }
  // `unreachable` falls through with no redirect — the caller renders it.
  return support
}

/**
 * The canonical form of `candidate` as a FHIR server base, or `undefined` when
 * it is not one this app will send requests to.
 *
 * @remarks
 * Deliberately duplicates the shape of `apps/wildflower-server-docs`'s
 * `server-target.ts` `normalizeServerUrl` — a slice cannot import from an app
 * (layering), and server-docs stays untouched in v1. If this gets a third
 * copy it should be hoisted to a shared package.
 *
 * Accepted: an absolute `http:`/`https:` URL with a host. Rejected: `javascript:`
 * and `data:` (a picked URL that became a script-injection vector), protocol-
 * relative `//host` and bare hosts (no scheme → no absolute parse), and any
 * other scheme. Canonicalising drops the query, fragment and userinfo, and
 * strips a trailing slash so the result concatenates cleanly with the leading-
 * slash paths the typed client emits.
 */
const normalizeServerUrl = (candidate: string): string | undefined => {
  let url: URL
  try {
    // No base argument: a relative or protocol-relative input has nothing to
    // resolve against and throws, which is exactly the rejection we want.
    url = new URL(candidate.trim())
  } catch {
    return undefined
  }

  // A hostless `http://` never gets this far — the URL parser rejects it for
  // these schemes — so a surviving `http:`/`https:` URL always has a host.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined

  const path = url.pathname.replace(/\/+$/u, '')
  return `${url.origin}${path}`
}

export {
  detectSmartSupport,
  normalizeServerUrl,
  startStandaloneLaunch,
  type SmartSupport,
  type StandaloneLaunchConfig,
}
