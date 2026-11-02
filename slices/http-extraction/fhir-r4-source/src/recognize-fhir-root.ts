import {
  type HttpMethod,
  type RecognizedUrlData,
  Specificity,
  SystemFamily,
  type UrlMatch,
} from '@wildflowerhealthio/http-extraction-fundamentals'
import { Option, pipe } from 'effect'

/**
 * Turn a kind's own {@link UrlMatch.UrlMatcher} into its `tryRecognize`: a
 * {@link Specificity.PROTOCOL}-tier claim whose `systemFamily` is the FHIR
 * style under the matcher's captured root. One pattern yields both the claim and the
 * root, so there is no second root regex to keep in step. `method` is
 * forwarded to the matcher, which enforces its own declared `verb` list.
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
        systemFamily: SystemFamily.FhirStyleBaseUrl({ baseUrl: root }),
      }))
    )

export { recognizeFhirRoot }
