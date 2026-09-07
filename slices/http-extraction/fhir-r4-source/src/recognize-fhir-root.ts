import { Option, pipe } from 'effect'
import {
  type HttpMethod,
  type RecognizedUrlData,
  Specificity,
  type UrlMatch,
} from 'http-extraction-fundamentals'

/**
 * Turn a kind's own {@link UrlMatch.UrlMatcher} into its `tryRecognize`: a
 * {@link Specificity.PROTOCOL}-tier claim whose `source` is the matcher's
 * captured root as **both** `system` and `baseUrl` (a FHIR server spells its
 * own references absolutely under that same prefix). One pattern yields both
 * the claim and the root, so there is no second root regex to keep in step.
 * `method` is forwarded to the matcher, which enforces its own declared
 * `verb` list.
 */
const recognizeFhirRoot =
  (
    matcher: UrlMatch.UrlMatcher
  ): ((url: string, method: Option.Option<HttpMethod>) => Option.Option<RecognizedUrlData>) =>
  (url, method) =>
    pipe(
      matcher(url, method),
      Option.map((root) => ({
        specificity: Specificity.PROTOCOL,
        source: { system: root, baseUrl: root },
      }))
    )

export { recognizeFhirRoot }
