/**
 * SMART discovery: finding the FHIR base — the SMART `iss` — a server URL
 * signs in through, and the OAuth endpoints it advertises.
 *
 * A server URL is either a Wildflower server's API base, whose FHIR base is
 * `{serverUrl}/fhir-r4`, or a plain SMART server's FHIR base itself (the
 * SmartHealthIT demo's `…/fhir`). Nothing in the URL says which, so
 * {@link discoverSmartEndpoints} asks: the Wildflower location first, and the
 * URL itself only when that answers 404. A path-prefixed Wildflower server
 * (`https://example.org/wildflower`) is found at the first, like any other.
 * A Wildflower server answers it from `slices/emr/emr-rust/src/smart_configuration.rs`
 * (mounted at `/fhir-r4/.well-known/smart-configuration`, and exempt from the
 * bearer gate — `gatekeeper-rust`'s `require_valid_bearer_token`), advertising
 * `authorization_endpoint` and `token_endpoint` derived from the origin it was
 * served on. Those advertised URLs are what the client uses; it never assumes
 * `/oauth/authorize` sits at the target's root.
 *
 * The validation is pure and returns an `Either`; the fetch is the async edge
 * and returns an `Effect` failing with {@link DiscoveryFailed}. Every failure a
 * reader can actually hit — target that is not a Wildflower server, server
 * down, blocked by CORS or mixed content — arrives as that one tagged error,
 * whose `reason` the header bar renders verbatim.
 */

import { Data, Effect, Either, Option, Schema } from 'effect'

/** Raised when the chosen target cannot be signed in to, with the reason why. */
class DiscoveryFailed extends Data.TaggedError('DiscoveryFailed')<{
  readonly reason: string
}> {}

/** The discovery document's path, relative to the SMART `iss` (a FHIR base). */
const SMART_CONFIGURATION_PATH = '/.well-known/smart-configuration'

/** The discovery URL for the FHIR base `fhirBaseUrl` (already canonical: no trailing slash). */
const smartConfigurationUrl = (fhirBaseUrl: string): string =>
  `${fhirBaseUrl}${SMART_CONFIGURATION_PATH}`

/** The two endpoints the authorization-code flow needs. */
interface SmartEndpoints {
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
}

/** Where a Wildflower server's FHIR API is mounted under its API base (`emr-rust`). */
const WILDFLOWER_FHIR_PATH = '/fhir-r4'

/**
 * A server's SMART issuer as discovery found it: the FHIR base that served the
 * configuration — the `iss`, and the `aud` a sign-in names — and the endpoints
 * it advertised.
 */
interface SmartIssuer {
  readonly fhirBaseUrl: string
  readonly endpoints: SmartEndpoints
}

/**
 * Hosts a browser treats as potentially trustworthy over plain `http:`
 * (W3C Secure Contexts §3.1): the loopback addresses. A desktop Wildflower host
 * serves its API on one of these, so an `http:` endpoint pointing at loopback is
 * accepted even from the HTTPS-published page — the same exception that makes
 * the client's ordinary requests to a loopback server work at all.
 */
const isLoopbackHost = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname === '[::1]' ||
  hostname === '::1' ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)

/**
 * `candidate` as an endpoint URL the client will send a reader (or a token
 * request) to, or `undefined` when it is not one.
 *
 * Rejected: anything that is not an absolute `http:`/`https:` URL; embedded
 * credentials (userinfo, which a redirect would carry into the address bar); a
 * fragment (the authorize URL grows query parameters, and a fragment would
 * strand them); and plain `http:` to a non-loopback host while the client
 * itself is on a secure page — a downgrade the browser would block anyway, and
 * which would put an access token on the wire in the clear.
 */
const usableEndpointUrl = (
  candidate: string,
  options: { readonly pageIsSecure: boolean }
): string | undefined => {
  let url: URL
  try {
    url = new URL(candidate.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username !== '' || url.password !== '') return undefined
  if (url.hash !== '') return undefined
  if (options.pageIsSecure && url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return undefined
  }
  return url.toString()
}

/**
 * Why a page cannot reach `serverUrl`, or `undefined` when it can.
 *
 * States when the target is chosen what {@link usableEndpointUrl} enforces
 * after the fetch, so the reader gets the real reason rather than a discovery
 * failure that reads as "the server is down". Loopback is deliberately not a
 * failure, for the reason {@link isLoopbackHost} gives.
 */
const insecureTargetReason = (
  serverUrl: string,
  options: { readonly pageIsSecure: boolean }
): string | undefined => {
  if (!options.pageIsSecure) return undefined
  let url: URL
  try {
    url = new URL(serverUrl)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' || isLoopbackHost(url.hostname)) return undefined
  return (
    `This page is served over https, so the browser will block its requests to ` +
    `${serverUrl}. Use an https address for the server, open this page over ` +
    `http from the server itself, or use a server on this computer.`
  )
}

/**
 * The part of a SMART configuration document (SMART App Launch §2.1) this
 * client reads. Only the two endpoints the flow needs are required.
 */
const SmartConfiguration = Schema.Struct({
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  code_challenge_methods_supported: Schema.optional(Schema.Array(Schema.String)),
})

const decodeSmartConfiguration = Schema.decodeUnknownEither(SmartConfiguration)

/**
 * The endpoints `document` advertises, or the reason it is unusable.
 *
 * `code_challenge_methods_supported` is checked for `S256` when present,
 * because a server that cannot do S256 cannot complete this client's flow (the
 * gatekeeper authorize endpoint mandates it) and failing here says so plainly;
 * a document that omits the field is given the benefit of the doubt rather than
 * blocked on a hint.
 */
const smartEndpointsFrom = (
  document: unknown,
  options: { readonly pageIsSecure: boolean }
): Either.Either<SmartEndpoints, DiscoveryFailed> => {
  const decoded = decodeSmartConfiguration(document)
  if (Either.isLeft(decoded)) {
    return Either.left(
      new DiscoveryFailed({
        reason:
          'The server’s SMART configuration is not a document that names an ' +
          'authorization_endpoint and token_endpoint.',
      })
    )
  }
  const configuration = decoded.right
  const authorizationEndpoint = usableEndpointUrl(configuration.authorization_endpoint, options)
  const tokenEndpoint = usableEndpointUrl(configuration.token_endpoint, options)
  if (authorizationEndpoint === undefined || tokenEndpoint === undefined) {
    return Either.left(
      new DiscoveryFailed({
        reason:
          'The server’s SMART configuration does not advertise a usable ' +
          'authorization_endpoint and token_endpoint over https (or loopback).',
      })
    )
  }
  const methods = configuration.code_challenge_methods_supported
  if (methods !== undefined && !methods.includes('S256')) {
    return Either.left(
      new DiscoveryFailed({
        reason: 'The server does not support PKCE with S256, which sign-in needs.',
      })
    )
  }
  return Either.right({ authorizationEndpoint, tokenEndpoint })
}

/**
 * Fetch the SMART configuration document under the FHIR base `fhirBaseUrl`:
 * `Some` with the body when it answered, `None` when it answered 404 — there
 * is no configuration there, which {@link discoverSmartEndpoints} may try
 * elsewhere.
 *
 * Every other way the request can fail — unreachable, another error status, a
 * non-JSON body — is a {@link DiscoveryFailed} naming the URL. An unreachable
 * server is never a 404: a network or CORS failure says nothing about where
 * the configuration is, so it must not send discovery on to a second URL.
 */
const fetchSmartConfiguration = (
  fhirBaseUrl: string,
  options: { readonly fetch: typeof globalThis.fetch }
): Effect.Effect<Option.Option<unknown>, DiscoveryFailed> =>
  Effect.gen(function* () {
    const url = smartConfigurationUrl(fhirBaseUrl)
    const response = yield* Effect.tryPromise({
      try: () => options.fetch(url, { headers: { Accept: 'application/json' } }),
      // A network-level failure is indistinguishable from a CORS rejection to
      // the page, so name both possibilities instead of guessing.
      catch: () =>
        new DiscoveryFailed({
          reason: `Could not reach ${url}. The server may be down, or the browser may have blocked the request.`,
        }),
    })
    if (response.status === 404) return Option.none()
    if (!response.ok) {
      return yield* new DiscoveryFailed({
        reason: `${url} answered ${String(response.status)}. Is this a Wildflower server?`,
      })
    }
    const document = yield* Effect.tryPromise({
      try: (): Promise<unknown> => response.json(),
      catch: () =>
        new DiscoveryFailed({
          reason: `${url} did not answer with JSON. Is this a Wildflower server?`,
        }),
    })
    return Option.some(document)
  })

/**
 * Find `serverUrl`'s SMART issuer and validate what it advertises.
 *
 * `serverUrl` (canonical: no trailing slash) is read as a Wildflower server's
 * API base first, so the configuration is asked for under
 * `{serverUrl}/fhir-r4`. Only if that answers 404 is `serverUrl` read as a
 * plain FHIR base and asked directly. The FHIR base that answered is returned
 * with the endpoints, for the sign-in to name as its `aud`. Two 404s fail with
 * one reason naming both URLs; any other failure at the first URL fails
 * without trying the second.
 */
const discoverSmartEndpoints = (
  serverUrl: string,
  options: { readonly fetch: typeof globalThis.fetch; readonly pageIsSecure: boolean }
): Effect.Effect<SmartIssuer, DiscoveryFailed> =>
  Effect.gen(function* () {
    const wildflowerFhirBaseUrl = `${serverUrl}${WILDFLOWER_FHIR_PATH}`
    const candidates = [wildflowerFhirBaseUrl, serverUrl]
    for (const fhirBaseUrl of candidates) {
      const document = yield* fetchSmartConfiguration(fhirBaseUrl, options)
      if (Option.isSome(document)) {
        const endpoints = yield* smartEndpointsFrom(document.value, {
          pageIsSecure: options.pageIsSecure,
        })
        return { fhirBaseUrl, endpoints }
      }
    }
    return yield* new DiscoveryFailed({
      reason:
        `Neither ${smartConfigurationUrl(wildflowerFhirBaseUrl)} nor ` +
        `${smartConfigurationUrl(serverUrl)} was found (both answered 404). ` +
        'Enter a Wildflower server’s address, or a SMART on FHIR server’s FHIR base URL.',
    })
  })

export {
  DiscoveryFailed,
  SMART_CONFIGURATION_PATH,
  smartConfigurationUrl,
  isLoopbackHost,
  usableEndpointUrl,
  insecureTargetReason,
  smartEndpointsFrom,
  discoverSmartEndpoints,
}
export type { SmartEndpoints, SmartIssuer }
