import { detach, type DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import {
  type HttpMethod,
  type HttpResponse,
  type RecognizedUrlData,
  Specificity,
  type UrlMatch,
} from '@wildflowerhealthio/http-extraction-fundamentals'
import { Effect, Option, ParseResult, pipe, Schema } from 'effect'

/**
 * Turn a kind's own {@link UrlMatch.UrlMatcher} into its `tryRecognize`: a
 * {@link Specificity.PROTOCOL}-tier claim for any URL the matcher captures a
 * FHIR server root from. `method` is forwarded to the matcher, which enforces
 * its own declared `verb` list.
 */
const recognizeFhirRoot =
  (
    matcher: UrlMatch.UrlMatcher
  ): ((url: string, method: Option.Option<HttpMethod>) => Option.Option<RecognizedUrlData>) =>
  (url, method) =>
    pipe(
      matcher(url, method),
      Option.map(() => ({ specificity: Specificity.PROTOCOL }))
    )

/**
 * Turn a parse of a FHIR server's records, as the server spelled them, into
 * the kind's `parse`: each record detached under the server's root, the same
 * root the kind's {@link recognizeFhirRoot} claimed the URL by.
 *
 * @param matcher - The kind's own URL matcher; one pattern yields both the
 *   claim and the root, so there is no second root regex to keep in step
 * @returns A function from the server-shaped parse to the kind's `parse`
 *
 * @remarks
 * A FHIR server's ids and literal references belong to that server, so this
 * is where they are detached (`fhir-r4-adoption`'s `detach` under the
 * root): a `Patient` keyed in `<root>/Patient`,
 * a reference to one, relative or absolute, turned logical by that key. A
 * response whose URL the matcher does not claim fails with a `ParseError`: it
 * was routed to this kind by a different claim than the kind makes.
 */
const detachUnderFhirRoot =
  (matcher: UrlMatch.UrlMatcher) =>
  (
    parseServerRecords: (
      response: HttpResponse.HttpResponse
    ) => Effect.Effect<readonly FhirResource[], ParseResult.ParseError>
  ) =>
  (
    response: HttpResponse.HttpResponse
  ): Effect.Effect<readonly DetachedResource.Type[], ParseResult.ParseError> =>
    Option.match(matcher(response.url, response.method), {
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
      onSome: (root) => {
        const detachUnderRoot = detach(root)
        return Effect.map(parseServerRecords(response), (records) => records.map(detachUnderRoot))
      },
    })

export { detachUnderFhirRoot, recognizeFhirRoot }
