import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { trimTrailingSlashes } from '@wildflowerhealthio/fhir-r4/clients'
import { Array as Arr, Context, Data, Effect, Layer, Match, Option, Schema } from 'effect'

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

/**
 * Where a request goes relative to the FHIR base: a path under it (the typed
 * client's `/Patient`, a reader's `Patient?_count=200`), an absolute URL that
 * is the base or under it on its origin (a search bundle's `next` link), or
 * an absolute URL anywhere else.
 */
type RequestTarget = Data.TaggedEnum<{
  readonly Relative: { readonly path: string }
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  readonly UnderFhirBase: Record<never, never>
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  readonly Elsewhere: Record<never, never>
}>
const RequestTarget = Data.taggedEnum<RequestTarget>()

/** True when `url` leads with a scheme, per RFC 3986's `scheme` production. */
const hasAbsoluteScheme = (url: string): boolean => /^[a-z][a-z0-9+.-]*:/iu.test(url)

/** Whether the absolute `url` is `fhirBaseUrl` or a path under it, on its origin. */
const isUnderFhirBase = (url: string, fhirBaseUrl: FhirBaseUrl): boolean => {
  const request = URL.parse(url)
  const base = URL.parse(fhirBaseUrl)
  if (request === null || base === null) return false
  const basePath = trimTrailingSlashes(base.pathname)
  return (
    request.origin === base.origin &&
    (request.pathname === basePath || request.pathname.startsWith(`${basePath}/`))
  )
}

/**
 * Where `url` goes relative to `fhirBaseUrl`. A relative URL's `path` has its
 * leading slashes dropped, so `/Patient` and `Patient` are the same path.
 */
const requestTargetOf = (url: string, fhirBaseUrl: FhirBaseUrl): RequestTarget => {
  if (!hasAbsoluteScheme(url)) return RequestTarget.Relative({ path: url.replace(/^\/+/u, '') })
  return isUnderFhirBase(url, fhirBaseUrl)
    ? RequestTarget.UnderFhirBase()
    : RequestTarget.Elsewhere()
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
 * One rule decides every request, by its {@link RequestTarget}:
 *
 * - **Relative**: addressed under `target.fhirBaseUrl`, with the token:
 *   `/Patient` and `Patient` both become `{fhirBaseUrl}/Patient`.
 * - **Under the FHIR base**: sent as it is, with the token.
 * - **Elsewhere**: sent as it is, bare, because the token was granted for this
 *   FHIR server alone and must never leave for a host that did not issue it.
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
    Match.value(requestTargetOf(request.url, target.fhirBaseUrl)).pipe(
      Match.tagsExhaustive({
        Relative: ({ path }) =>
          withToken(HttpClientRequest.setUrl(request, `${target.fhirBaseUrl}/${path}`)),
        UnderFhirBase: () => withToken(request),
        Elsewhere: () => request,
      })
    )
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
     * bundle's `next` link) as it is, the token on it only when it is for the
     * FHIR server (see {@link addressedTo}).
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
  FhirHttpError,
  FhirRequestDropped,
  FhirResponseNotJson,
  RequestTarget,
  requestTargetOf,
  SmartClient,
  type FhirRequestError,
}
