/**
 * SMART discovery: turning the `?server=` target into the OAuth endpoints the
 * console must send the reader to.
 *
 * The target is treated as the SMART `iss`, so nothing about the server's URL
 * layout is hardcoded here beyond the one well-known path SMART itself defines.
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

import { Data, Effect, Either } from 'effect'

/** Raised when the chosen target cannot be signed in to, with the reason why. */
class DiscoveryFailed extends Data.TaggedError('DiscoveryFailed')<{
  readonly reason: string
}> {}

/** The discovery document's path, relative to the SMART `iss` base. */
const SMART_CONFIGURATION_PATH = '/fhir-r4/.well-known/smart-configuration'

/** The discovery URL for `serverUrl` (already canonical: no trailing slash). */
const smartConfigurationUrl = (serverUrl: string): string =>
  `${serverUrl}${SMART_CONFIGURATION_PATH}`

/** The two endpoints the authorization-code flow needs. */
interface SmartEndpoints {
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
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
  candidate: unknown,
  options: { readonly pageIsSecure: boolean }
): string | undefined => {
  if (typeof candidate !== 'string' || candidate.trim() === '') return undefined
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

/** Whether `value` is a plain JSON object. */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The endpoints `document` advertises, or the reason it is unusable.
 *
 * Only the two endpoints the flow needs are required. `code_challenge_methods_supported`
 * is checked for `S256` when present, because a server that cannot do S256
 * cannot complete this client's flow (the gatekeeper authorize endpoint
 * mandates it) and failing here says so plainly; a document that omits the
 * field is given the benefit of the doubt rather than blocked on a hint.
 */
const smartEndpointsFrom = (
  document: unknown,
  options: { readonly pageIsSecure: boolean }
): Either.Either<SmartEndpoints, DiscoveryFailed> => {
  if (!isRecord(document)) {
    return Either.left(
      new DiscoveryFailed({ reason: 'The server’s SMART configuration is not a JSON object.' })
    )
  }
  const authorizationEndpoint = usableEndpointUrl(document.authorization_endpoint, options)
  const tokenEndpoint = usableEndpointUrl(document.token_endpoint, options)
  if (authorizationEndpoint === undefined || tokenEndpoint === undefined) {
    return Either.left(
      new DiscoveryFailed({
        reason:
          'The server’s SMART configuration does not advertise a usable ' +
          'authorization_endpoint and token_endpoint over https (or loopback).',
      })
    )
  }
  const methods = document.code_challenge_methods_supported
  if (Array.isArray(methods) && !methods.includes('S256')) {
    return Either.left(
      new DiscoveryFailed({
        reason: 'The server does not support PKCE with S256, which sign-in needs.',
      })
    )
  }
  return Either.right({ authorizationEndpoint, tokenEndpoint })
}

/**
 * Fetch and validate `serverUrl`'s SMART configuration.
 *
 * The three ways the request itself can fail — unreachable, error status,
 * non-JSON body — each become a {@link DiscoveryFailed} naming the URL, and the
 * body is then handed to {@link smartEndpointsFrom}, whose `Either` is lifted
 * into the same failure channel.
 */
const discoverSmartEndpoints = (
  serverUrl: string,
  options: { readonly fetch: typeof globalThis.fetch; readonly pageIsSecure: boolean }
): Effect.Effect<SmartEndpoints, DiscoveryFailed> =>
  Effect.gen(function* () {
    const url = smartConfigurationUrl(serverUrl)
    const response = yield* Effect.tryPromise({
      try: () => options.fetch(url, { headers: { Accept: 'application/json' } }),
      // A network-level failure is indistinguishable from a CORS rejection to
      // the page, so name both possibilities instead of guessing.
      catch: () =>
        new DiscoveryFailed({
          reason: `Could not reach ${url}. The server may be down, or the browser may have blocked the request.`,
        }),
    })
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
    return yield* smartEndpointsFrom(document, { pageIsSecure: options.pageIsSecure })
  })

export {
  DiscoveryFailed,
  SMART_CONFIGURATION_PATH,
  smartConfigurationUrl,
  usableEndpointUrl,
  smartEndpointsFrom,
  discoverSmartEndpoints,
}
export type { SmartEndpoints }
