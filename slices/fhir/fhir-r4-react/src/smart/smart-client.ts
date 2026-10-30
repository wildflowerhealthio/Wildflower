import type { Session } from '@wildflowerhealthio/authorization-core/smart-client'
import { trimTrailingSlashes } from '@wildflowerhealthio/fhir-r4/clients'
import { Data, Effect, Option } from 'effect'

/** The FHIR server answered a request with an error status (4xx or 5xx). */
class FhirHttpError extends Data.TaggedError('FhirHttpError')<{
  /** The URL the request went to. */
  readonly url: string
  readonly status: number
}> {}

/**
 * No HTTP response arrived at all: `fetch` rejected, as it does when a
 * browser's CORS or Local Network Access check blocks the request, the
 * connection drops, or the server is down. The page cannot tell these apart.
 */
class FhirRequestDropped extends Data.TaggedError('FhirRequestDropped')<{
  /** The URL the request went to. */
  readonly url: string
  readonly cause: unknown
}> {}

/** The FHIR server answered with a success status and a body that is not JSON. */
class FhirResponseNotJson extends Data.TaggedError('FhirResponseNotJson')<{
  /** The URL the request went to. */
  readonly url: string
  readonly cause: unknown
}> {}

/** Every way a {@link SmartClient.request} can fail. */
type FhirRequestError = FhirHttpError | FhirRequestDropped | FhirResponseNotJson

/**
 * The FHIR server a completed SMART handshake connected the app to, and the
 * one read the app makes against it.
 *
 * @remarks
 * Its `serverUrl` and `accessToken` are a `SmartSession`, so the client itself
 * is what `buildSmartRouterContext` takes. The token lives in this object
 * only, in page memory, and dies with the tab.
 */
interface SmartClient {
  /** The FHIR base the handshake connected to, with no trailing slash. */
  readonly serverUrl: string
  /** The bearer token the sign-in redeemed, or `undefined` for an open server. */
  readonly accessToken: string | undefined
  /** The patient the launch put in context, when the token response named one. */
  readonly launchPatientId: Option.Option<string>
  /**
   * GET `url` and read the answer as JSON.
   *
   * @remarks
   * A relative `url` (`Patient?_count=200`) is resolved against `serverUrl`; an
   * absolute one (a search bundle's `next` link) is requested as it is. The
   * bearer token rides only a request to `serverUrl` or a path under it: an
   * absolute URL anywhere else goes out with no credential, because the token
   * is for this FHIR server alone.
   */
  readonly request: (url: string) => Effect.Effect<unknown, FhirRequestError>
}

/**
 * What a {@link SmartClient} is made from: a redeemed sign-in `Session`, or an
 * open server's address with no token.
 */
type SmartConnection = Pick<Session, 'serverUrl' | 'patient'> & {
  readonly accessToken: string | undefined
}

/** True when `url` leads with a scheme, per RFC 3986's `scheme` production. */
const hasAbsoluteScheme = (url: string): boolean => /^[a-z][a-z0-9+.-]*:/iu.test(url)

/** `url` resolved against the FHIR base `fhirBaseUrl` (no trailing slash) when it is relative. */
const requestUrlFor = (fhirBaseUrl: string, url: string): string =>
  hasAbsoluteScheme(url) ? url : `${fhirBaseUrl}/${url.replace(/^\/+/u, '')}`

/** Whether `requestUrl` is the FHIR base `fhirBaseUrl` or a path under it, on its origin. */
const isUnderFhirBase = (requestUrl: string, fhirBaseUrl: string): boolean => {
  const request = URL.parse(requestUrl)
  const base = URL.parse(fhirBaseUrl)
  if (request === null || base === null) return false
  const basePath = trimTrailingSlashes(base.pathname)
  return (
    request.origin === base.origin &&
    (request.pathname === basePath || request.pathname.startsWith(`${basePath}/`))
  )
}

/**
 * The {@link SmartClient} for `connection`, making its requests with `fetch`.
 *
 * @param connection - The redeemed session, or an open server with no token
 * @param fetch - The transport; the page passes its own `fetch`, a test a stub
 */
const smartClientFor = (
  connection: SmartConnection,
  fetch: typeof globalThis.fetch
): SmartClient => {
  const serverUrl = trimTrailingSlashes(connection.serverUrl)
  const { accessToken } = connection
  const headersFor = (requestUrl: string): Record<string, string> =>
    accessToken !== undefined && isUnderFhirBase(requestUrl, serverUrl)
      ? { Accept: 'application/json', Authorization: `Bearer ${accessToken}` }
      : { Accept: 'application/json' }
  const request = (url: string): Effect.Effect<unknown, FhirRequestError> =>
    Effect.gen(function* () {
      const requestUrl = requestUrlFor(serverUrl, url)
      const response = yield* Effect.tryPromise({
        try: (signal) => fetch(requestUrl, { headers: headersFor(requestUrl), signal }),
        catch: (cause) => new FhirRequestDropped({ url: requestUrl, cause }),
      })
      if (!response.ok) {
        return yield* new FhirHttpError({ url: requestUrl, status: response.status })
      }
      return yield* Effect.tryPromise({
        try: (): Promise<unknown> => response.json(),
        catch: (cause) => new FhirResponseNotJson({ url: requestUrl, cause }),
      })
    })
  return {
    serverUrl,
    accessToken,
    launchPatientId: Option.fromNullable(connection.patient).pipe(
      Option.filter((patientId) => patientId !== '')
    ),
    request,
  }
}

export {
  FhirHttpError,
  FhirRequestDropped,
  FhirResponseNotJson,
  hasAbsoluteScheme,
  smartClientFor,
  type FhirRequestError,
  type SmartClient,
  type SmartConnection,
}
