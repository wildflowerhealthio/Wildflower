import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { trimTrailingSlashes } from '@wildflowerhealthio/fhir-r4/clients'
import { Array as Arr, Context, Data, Effect, Either, Layer, Option, Schema } from 'effect'

import type { FhirBaseUrl, SmartConnection } from './smart-connection.ts'

/**
 * The parts of an OperationOutcome a person can read: each issue's
 * `diagnostics` and `details.text`.
 */
const OperationOutcomeText = Schema.Struct({
  resourceType: Schema.Literal('OperationOutcome'),
  issue: Schema.Array(
    Schema.Struct({
      diagnostics: Schema.optional(Schema.String),
      details: Schema.optional(Schema.Struct({ text: Schema.optional(Schema.String) })),
    })
  ),
})

const decodeOperationOutcomeText = Schema.decodeUnknownOption(OperationOutcomeText)

/**
 * What the OperationOutcome `body` says, its issues' texts joined, or `None`
 * when `body` is not an OperationOutcome or says nothing.
 */
const operationOutcomeTextOf = (body: unknown): Option.Option<string> =>
  decodeOperationOutcomeText(body).pipe(
    Option.map(({ issue }) =>
      issue.flatMap((each) =>
        [each.details?.text, each.diagnostics].filter(
          (text): text is string => text !== undefined && text !== ''
        )
      )
    ),
    Option.filter(Arr.isNonEmptyReadonlyArray),
    Option.map(Arr.join('; '))
  )

/** The FHIR server answered a request with an error status (4xx or 5xx). */
class FhirHttpError extends Data.TaggedError('FhirHttpError')<{
  /** The URL the request went to. */
  readonly url: string
  readonly status: number
  /** What the OperationOutcome the server answered with says, when it sent one. */
  readonly outcomeText: Option.Option<string>
}> {
  /** `{status} from {url}`, then the OperationOutcome's text when there is one. */
  override get message(): string {
    const answered = `${String(this.status)} from ${this.url}`
    return Option.match(this.outcomeText, {
      onNone: () => answered,
      onSome: (text) => `${answered}: ${text}`,
    })
  }
}

/**
 * No HTTP response arrived at all: the request was refused before it left, as
 * a browser refuses one its CORS or Local Network Access check blocks, the
 * connection dropped, or the server is down. The page cannot tell these apart.
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

/** Every way a `SmartClient`'s `request` can fail. */
type FhirRequestError = FhirHttpError | FhirRequestDropped | FhirResponseNotJson

/** Whether the parsed `request` is `base` or a path under it, on its origin. */
const isUnderFhirBase = (request: URL, base: URL): boolean => {
  const basePath = trimTrailingSlashes(base.pathname)
  return (
    request.origin === base.origin &&
    (request.pathname === basePath || request.pathname.startsWith(`${basePath}/`))
  )
}

/**
 * `url` resolved against `fhirBaseUrl`: on the right when it is the FHIR base
 * or a path under it, on the left when it is anywhere else.
 *
 * @remarks
 * A relative `url` is a path under the base, its leading slashes dropped, so
 * `/Patient` and `Patient` both resolve to `{fhirBaseUrl}/Patient`. The
 * check runs on the resolved URL, after the WHATWG parser has removed its dot
 * segments (`%2e%2e` included), so `../r4-admin/Patient` resolves outside the
 * base and lands on the left. A URL that does not parse is on the left as it
 * is.
 */
const addressedUnderFhirBase = (
  url: string,
  fhirBaseUrl: FhirBaseUrl
): Either.Either<string, string> => {
  const base = URL.parse(`${fhirBaseUrl}/`)
  const request = URL.parse(url.replace(/^\/+/u, ''), `${fhirBaseUrl}/`)
  if (base === null || request === null) return Either.left(url)
  return isUnderFhirBase(request, base) ? Either.right(request.href) : Either.left(request.href)
}

/**
 * `client`, with every request for the FHIR server addressed to it and
 * carrying the SMART bearer token, and no other request doing so.
 *
 * @remarks
 * Both halves are needed because a SMART app is served from its **own** origin
 * (its published site, or `http://localhost:{port}/` under its dev server), not
 * the FHIR server's. Left alone, a relative `/Patient` would resolve against
 * the app's origin, and nothing else authenticates the app cross-origin. So
 * this app authenticates the way any third-party SMART app does: with the
 * token it was granted.
 *
 * One rule decides every request, by {@link addressedUnderFhirBase}: the
 * request goes to its URL resolved against `target.fhirBaseUrl` (`/Patient`
 * and `Patient` both become `{fhirBaseUrl}/Patient`), with the token when
 * that is the FHIR base or a path under it, and bare anywhere else, because
 * the token was granted for this FHIR server alone and must never leave for a
 * host or path that did not issue it.
 *
 * A target with no `accessToken` sets no header at all, rather than an empty
 * `Bearer `: an absent credential must read as absent.
 */
const addressedTo = (
  target: Pick<SmartConnection, 'fhirBaseUrl' | 'accessToken'>
): ((client: HttpClient.HttpClient) => HttpClient.HttpClient) => {
  const withToken = (
    request: HttpClientRequest.HttpClientRequest
  ): HttpClientRequest.HttpClientRequest =>
    Option.match(target.accessToken, {
      onNone: () => request,
      onSome: (token) => HttpClientRequest.bearerToken(request, token),
    })
  return HttpClient.mapRequest((request) =>
    Either.match(addressedUnderFhirBase(request.url, target.fhirBaseUrl), {
      onLeft: (url) => HttpClientRequest.setUrl(request, url),
      onRight: (url) => withToken(HttpClientRequest.setUrl(request, url)),
    })
  )
}

/** The {@link FhirHttpError} for the error-status `response`, read from its body. */
const fhirHttpErrorFrom = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<FhirHttpError> =>
  response.json.pipe(
    Effect.option,
    Effect.map(
      (body) =>
        new FhirHttpError({
          url: response.request.url,
          status: response.status,
          outcomeText: Option.flatMap(body, operationOutcomeTextOf),
        })
    )
  )

/** GET `url` through `client` and read the answer as JSON. */
const requestJson =
  (client: HttpClient.HttpClient) =>
  (url: string): Effect.Effect<unknown, FhirRequestError> =>
    client.get(url, { acceptJson: true }).pipe(
      Effect.flatMap(
        HttpClientResponse.matchStatus({
          '2xx': (response) => response.json,
          orElse: (response) => Effect.flatMap(fhirHttpErrorFrom(response), Effect.fail),
        })
      ),
      Effect.catchTags({
        // No response arrived: refused before it left, or the connection dropped.
        RequestError: (failure) =>
          Effect.fail(new FhirRequestDropped({ url: failure.request.url, cause: failure })),
        // A success status whose body did not read as JSON.
        ResponseError: (failure) =>
          Effect.fail(new FhirResponseNotJson({ url: failure.request.url, cause: failure })),
      })
    )

/**
 * The FHIR server a completed SMART sign-in connected the app to, and the one
 * read every SMART reader here makes against it.
 *
 * @remarks
 * Built by {@link SmartClient.layer} over the page's `HttpClient`.
 */
class SmartClient extends Context.Tag('fhir-r4-react/SmartClient')<
  SmartClient,
  {
    /** The server the sign-in connected to, and the token it holds for it. */
    readonly connection: SmartConnection
    /**
     * GET `url` and read the answer as JSON: a relative `url`
     * (`Patient?_count=200`) under the FHIR base, an absolute one (a search
     * bundle's `next` link) where it points, the token on it only when it
     * resolves under the FHIR base (see {@link addressedTo}).
     */
    readonly request: (url: string) => Effect.Effect<unknown, FhirRequestError>
  }
>() {
  /**
   * The {@link SmartClient} for `connection`, its requests addressed by
   * {@link addressedTo} over the `HttpClient` it is given: the app's
   * `FetchHttpClient.layer`, a test's stub.
   */
  static readonly layer = (
    connection: SmartConnection
  ): Layer.Layer<SmartClient, never, HttpClient.HttpClient> =>
    Layer.effect(
      SmartClient,
      Effect.map(HttpClient.HttpClient, (client) =>
        SmartClient.of({ connection, request: requestJson(addressedTo(connection)(client)) })
      )
    )
}

export {
  addressedTo,
  addressedUnderFhirBase,
  FhirHttpError,
  FhirRequestDropped,
  FhirResponseNotJson,
  SmartClient,
  type FhirRequestError,
}
