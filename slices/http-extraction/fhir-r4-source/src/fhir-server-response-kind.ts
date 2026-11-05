/**
 * A FHIR server's response kind, declared: the URLs it claims and how it reads
 * the server's records off a body, every record detached under the server's
 * root.
 *
 * @packageDocumentation
 */
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import {
  type HttpMethod,
  type HttpResponse,
  HttpResponseKind,
  type RecognizedUrlData,
  Specificity,
  type UrlMatch,
} from '@wildflowerhealthio/http-extraction-fundamentals'
import { Effect, Option, ParseResult, pipe, Schema } from 'effect'

import { extractJson } from './extract-json.ts'

/** What a FHIR server's response kind declares. */
interface Definition<TResource extends FhirResource> {
  /** The kind's name, for logging and reporting which kind claimed a response. */
  readonly name: string
  /** The URLs the kind claims, each yielding the server's root. */
  readonly url: UrlMatch.UrlMatcher
  /** The server's records in a response body, as the server wrote them. */
  readonly records: (body: string) => Effect.Effect<readonly TResource[], ParseResult.ParseError>
}

/**
 * A {@link Specificity.PROTOCOL}-tier claim for any URL `url` yields a root
 * for; `method` is forwarded to the matcher, which enforces its own verbs.
 */
const recognizeFhirRoot =
  (
    url: UrlMatch.UrlMatcher
  ): ((
    candidateUrl: string,
    method: Option.Option<HttpMethod>
  ) => Option.Option<RecognizedUrlData>) =>
  (candidateUrl, method) =>
    pipe(
      url(candidateUrl, method),
      Option.map(() => ({ specificity: Specificity.PROTOCOL }))
    )

/**
 * The server root `url` yields for `response`'s URL, failing with a
 * `ParseError` for a URL it does not claim: one routed to the kind by another
 * claim than its own.
 */
const claimedRootOf = (
  url: UrlMatch.UrlMatcher,
  response: HttpResponse.HttpResponse
): Effect.Effect<string, ParseResult.ParseError> =>
  Option.match(url(response.url, response.method), {
    onNone: () =>
      Effect.fail(
        new ParseResult.ParseError({
          issue: new ParseResult.Forbidden(
            Schema.String.ast,
            response.url,
            'not a FHIR server URL this kind claims'
          ),
        })
      ),
    onSome: Effect.succeed,
  })

/**
 * The response kind a {@link Definition} declares: it claims what `url`
 * matches, and parses a response into its `records`, each detached under the
 * root `url` yields for the response's URL (`<root>/<Type>` keys, references
 * to the server's own records logical).
 */
const make = <TResource extends FhirResource>({
  name,
  url,
  records,
}: Definition<TResource>): HttpResponseKind.HttpResponseKind<
  DetachedResource.Detached<TResource>
> =>
  HttpResponseKind.make({
    name,
    tryRecognize: recognizeFhirRoot(url),
    parse: (response) =>
      Effect.gen(function* () {
        const root = yield* claimedRootOf(url, response)
        const served = yield* records(extractJson(response.text()))
        return served.map(DetachedResource.fromServerRecord(root))
      }),
  })

export { make }
export type { Definition }
