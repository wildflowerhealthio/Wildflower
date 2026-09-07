import { DateTime, Effect, Option, ParseResult, Schema } from 'effect'

import type * as Extraction from './extraction.ts'
import type { HttpMethod } from './http-method.ts'
import * as HttpResponseKind from './http-response-kind.ts'
import * as HttpResponse from './http-response.ts'
import { Specificity } from './specificity.ts'

/**
 * Fields a test wants to vary on an
 * {@link HttpResponse.HttpResponse}; everything omitted takes a
 * benign default.
 */
interface HttpResponseOverrides {
  readonly id?: string
  readonly url?: string
  /** Defaults to `Option.some('GET')`. */
  readonly method?: Option.Option<HttpMethod>
  readonly status?: number
  readonly statusText?: string
  readonly headers?: HttpResponse.Headers
  /** The observed response-start instant. Fixed by default, so tests stay deterministic. */
  readonly startedAt?: DateTime.Utc
  /** Body bytes. A `string` is UTF-8 encoded; pass a `Uint8Array` for a non-UTF-8 body. */
  readonly body?: string | Uint8Array
}

const utf8 = new TextEncoder()

/** The default {@link makeHttpResponse} `startedAt` — fixed, so tests are deterministic. */
const DEFAULT_STARTED_AT = DateTime.unsafeMake('2026-01-01T00:00:00.000Z')

/**
 * Build an {@link HttpResponse.HttpResponse} for a test,
 * defaulting every field a test does not care about.
 *
 * @param overrides - The fields to set; see {@link HttpResponseOverrides}
 * @returns An `HttpResponse` over the given (or empty) body
 */
const makeHttpResponse = (overrides: HttpResponseOverrides = {}): HttpResponse.HttpResponse => {
  const body = overrides.body
  return HttpResponse.make({
    id: overrides.id ?? 'req-1',
    url: overrides.url ?? 'https://example.com/resource/id',
    method: overrides.method ?? Option.some('GET'),
    status: overrides.status ?? 200,
    statusText: overrides.statusText ?? 'OK',
    headers: overrides.headers ?? [['content-type', 'application/json']],
    startedAt: overrides.startedAt ?? DEFAULT_STARTED_AT,
    body: typeof body === 'string' ? utf8.encode(body) : (body ?? new Uint8Array()),
  })
}

/**
 * Two reusable test response kinds mirroring the shape a real response kind
 * (e.g. `PatientResponseKind`) takes — a value built via
 * `HttpResponseKind.make`, no inheritance.
 */

const SimpleSchema = Schema.Struct({
  name: Schema.String,
  age: Schema.Number,
})

/**
 * Recognize a URL matching `pattern` with a fixed `specificity` (and optional
 * `source`), `None` otherwise — the `tryRecognize` shape the test kinds share.
 */
const recognizeMatching =
  (
    pattern: RegExp,
    recognized: HttpResponseKind.RecognizedUrlData
  ): ((url: string) => Option.Option<HttpResponseKind.RecognizedUrlData>) =>
  (url) =>
    pattern.test(url) ? Option.some(recognized) : Option.none()

// The two reusable kinds carry DISTINCT specificities so a routing test can
// exercise the highest-specificity-wins ranking, and `SimpleResponseKind`
// carries a `source` (so `recognize`/`routeTo` can be checked minting an
// identity) while `AnotherResponseKind` mints none.
const SimpleResponseKind: HttpResponseKind.HttpResponseKind<typeof SimpleSchema.Type> =
  HttpResponseKind.make({
    name: 'SimpleResponseKind',
    tryRecognize: (url) =>
      recognizeMatching(/\/people\/\d+$/, {
        specificity: Specificity.PORTAL,
        source: { system: 'https://example.test/people' },
      })(url),
    parse: (response) =>
      Effect.map(Schema.decode(Schema.parseJson(SimpleSchema))(response.text()), (data) => [data]),
  })

const AnotherSchema = Schema.Struct({ id: Schema.String })

const AnotherResponseKind: HttpResponseKind.HttpResponseKind<typeof AnotherSchema.Type> =
  HttpResponseKind.make({
    name: 'AnotherResponseKind',
    tryRecognize: (url) =>
      recognizeMatching(/\/items\//, { specificity: Specificity.PROTOCOL })(url),
    parse: (response) =>
      Effect.map(Schema.decode(Schema.parseJson(AnotherSchema))(response.text()), (data) => [data]),
  })

/**
 * What the {@link echoResponseKind} test entities decode to: the response fields
 * they were handed, echoed back.
 *
 * @remarks
 * Echoing rather than decoding a payload is what lets a property assert
 * *provenance* — that this batch came from that response, and that the bytes
 * `parse` saw are the bytes the input carried — without the test knowing what
 * the generated body was.
 */
interface Echo {
  readonly responseKindName: string
  readonly id: string
  readonly url: string
  readonly status: number
  readonly statusText: string
  readonly headers: readonly (readonly [string, string])[]
  readonly bytes: Uint8Array
}

/**
 * An entity claiming every URL containing `/<marker>/`, decoding to a single
 * {@link Echo} — unless the body is the literal `POISON`, which fails the
 * parse.
 *
 * @remarks
 * The poison body is how a property makes a *specific* response fail without
 * changing which entity claims it, so parse-failure isolation is testable
 * against an otherwise identical fold. `specificity` defaults to
 * `Specificity.PROTOCOL`; pass a different tier to exercise highest-specificity
 * routing between two markers that overlap.
 */
const echoResponseKind = (
  name: string,
  marker: string,
  specificity: number = Specificity.PROTOCOL
): HttpResponseKind.HttpResponseKind<Echo> =>
  HttpResponseKind.make({
    name,
    tryRecognize: (url) =>
      // Echo kinds ignore the request method — the ranking tests don't care.
      url.includes(`/${marker}/`) ? Option.some({ specificity }) : Option.none(),
    parse: (response) =>
      response.text() === POISON_BODY
        ? Effect.fail(
            new ParseResult.ParseError({
              issue: new ParseResult.Type(Schema.String.ast, response.url, 'poisoned body'),
            })
          )
        : Effect.succeed([
            {
              responseKindName: name,
              id: response.id,
              url: response.url,
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
              bytes: response.bytes(),
            },
          ]),
  })

/** The body an {@link echoResponseKind} refuses to parse. */
const POISON_BODY = 'POISON'

/** Fixed instant, so a generated response never depends on the clock. */
const EXTRACTION_STARTED_AT = DateTime.unsafeMake('2026-02-02T00:00:00.000Z')

/** Build an {@link Extraction.Input}, defaulting everything a test doesn't set. */
const makeExtractionInput = (
  overrides: Partial<Omit<Extraction.Input, 'body'>> & { readonly body?: string | Uint8Array } = {}
): Extraction.Input => ({
  id: overrides.id ?? 'req-1',
  url: overrides.url ?? 'https://example.com/alpha/1',
  method: overrides.method ?? Option.some('GET'),
  status: overrides.status ?? 200,
  statusText: overrides.statusText ?? 'OK',
  headers: overrides.headers ?? [['content-type', 'application/json']],
  startedAt: overrides.startedAt ?? EXTRACTION_STARTED_AT,
  body:
    typeof overrides.body === 'string'
      ? utf8.encode(overrides.body)
      : (overrides.body ?? utf8.encode('{}')),
  bodyAbsent: overrides.bodyAbsent ?? false,
})

export {
  AnotherResponseKind,
  DEFAULT_STARTED_AT,
  echoResponseKind,
  EXTRACTION_STARTED_AT,
  makeExtractionInput,
  makeHttpResponse,
  POISON_BODY,
  SimpleResponseKind,
}
export type { Echo, HttpResponseOverrides }
// The archive-runner reference model — demoted from `Extraction` when the
// interactive review replaced it in production; see run-extraction.ts.
export { runExtraction } from './run-extraction.ts'
export type { ExtractionResult } from './run-extraction.ts'
