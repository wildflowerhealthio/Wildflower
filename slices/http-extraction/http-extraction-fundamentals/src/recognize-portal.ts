import { Option } from 'effect'

import type { HttpMethod } from './http-method.ts'
import type { RecognizedUrlData } from './http-response-kind.ts'
import { Specificity } from './specificity.ts'
import type { UrlMatcher } from './url-match.ts'

/**
 * Build a portal-tier `tryRecognize` from a URL matcher and a constant source
 * system. The returned function yields
 * `{ specificity: PORTAL, source: { system } }` for any URL the matcher
 * claims, `None` otherwise — the portal counterpart of `fhir-r4-source`'s
 * `recognizeFhirRoot`, which derives `system` from the URL itself.
 *
 * Accepts either a {@link UrlMatcher} (which enforces its own `verb` list, so
 * the `method` argument is honoured) or a `RegExp` (tested against the URL
 * only; the `method` argument is ignored — a portal kind that wants to
 * enforce a verb should pass a `UrlMatch.make`-built matcher instead).
 */
const recognizePortal =
  (
    matcher: UrlMatcher | RegExp,
    system: string
  ): ((url: string, method: Option.Option<HttpMethod>) => Option.Option<RecognizedUrlData>) =>
  (url, method) => {
    const matched =
      matcher instanceof RegExp ? matcher.test(url) : Option.isSome(matcher(url, method))
    return matched
      ? Option.some({ specificity: Specificity.PORTAL, source: { system } })
      : Option.none()
  }

export { recognizePortal }
