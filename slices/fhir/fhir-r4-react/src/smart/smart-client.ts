import { HttpClient, HttpClientResponse } from '@effect/platform'
import type { Session } from '@wildflowerhealthio/authorization-core/smart-client'
import { trimTrailingSlashes } from '@wildflowerhealthio/fhir-r4/clients'
import type { Layer } from 'effect'
import { Array as Arr, Data, Effect, Option, Schema } from 'effect'

import { smartHttpClientLayer } from './smart-runtime.ts'

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
   * The request goes out through `smartHttpClientLayer`, the rule every read
   * of the session follows: a relative `url` (`Patient?_count=200`) is resolved
   * against `serverUrl`, and an absolute one (a search bundle's `next` link) is
   * requested as it is. The bearer token rides only a request to `serverUrl` or
   * a path under it: an absolute URL anywhere else goes out with no
   * credential, because the token is for this FHIR server alone.
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

/**
 * The {@link SmartClient} for `connection`, making its requests through
 * `smartHttpClientLayer` over `transport`.
 *
 * @param connection - The redeemed session, or an open server with no token
 * @param transport - The `HttpClient` the requests go out over; the app passes
 *   `FetchHttpClient.layer`, a test a stub
 */
const smartClientFor = (
  connection: SmartConnection,
  transport: Layer.Layer<HttpClient.HttpClient>
): SmartClient => {
  const serverUrl = trimTrailingSlashes(connection.serverUrl)
  const { accessToken } = connection
  const httpLayer = smartHttpClientLayer({ serverUrl, accessToken }, transport)
  const request = (url: string): Effect.Effect<unknown, FhirRequestError> =>
    HttpClient.get(url, { acceptJson: true }).pipe(
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
      }),
      Effect.provide(httpLayer)
    )
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
  smartClientFor,
  type FhirRequestError,
  type SmartClient,
  type SmartConnection,
}
