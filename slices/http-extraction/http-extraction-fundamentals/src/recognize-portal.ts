import { Option } from 'effect'

import type { RecognizedUrlData } from './http-response-kind.ts'
import { Specificity } from './specificity.ts'
import type { UrlMatcher } from './url-match.ts'

/**
 * Build a portal-tier `tryRecognize` from a URL matcher and a constant source
 * system. The returned function yields
 * `{ specificity: PORTAL, source: { system } }` for any URL the matcher claims,
 * `None` otherwise — the portal counterpart of `fhir-r4-source`'s
 * `recognizeFhirRoot`, which derives `system` from the URL itself.
 *
 * Accepts either a {@link UrlMatcher} (the captured root is ignored — portal
 * references are relative, so there is no base URL to key under) or a `RegExp`
 * (tested against the URL).
 */
const recognizePortal =
  (
    matcher: UrlMatcher | RegExp,
    system: string
  ): ((url: string) => Option.Option<RecognizedUrlData>) =>
  (url) => {
    const matched = matcher instanceof RegExp ? matcher.test(url) : Option.isSome(matcher(url))
    return matched
      ? Option.some({ specificity: Specificity.PORTAL, source: { system } })
      : Option.none()
  }

export { recognizePortal }
