import { Option } from 'effect'

import type { HttpMethod } from './http-method.ts'
import type { RecognizedUrlData } from './http-response-kind.ts'
import { Specificity } from './specificity.ts'
import type * as SystemFamily from './system-family.ts'
import type { UrlMatcher } from './url-match.ts'

/**
 * Build a portal-tier `tryRecognize` from a URL matcher and the portal's
 * constant system family. The returned function yields
 * `{ specificity: PORTAL, systemFamily }` for any URL the matcher claims,
 * `None` otherwise — the portal counterpart of `fhir-r4-source`'s
 * `recognizeFhirRoot`, which reads a FHIR server's base URL off the URL
 * itself.
 *
 * Accepts either a {@link UrlMatcher} (which enforces its own `verb` list, so
 * the `method` argument is honoured) or a `RegExp` (tested against the URL
 * only; the `method` argument is ignored — a portal kind that wants to
 * enforce a verb should pass a `UrlMatch.make`-built matcher instead).
 */
const recognizePortal =
  (
    matcher: UrlMatcher | RegExp,
    systemFamily: SystemFamily.Type
  ): ((url: string, method: Option.Option<HttpMethod>) => Option.Option<RecognizedUrlData>) =>
  (url, method) => {
    const matched =
      matcher instanceof RegExp ? matcher.test(url) : Option.isSome(matcher(url, method))
    return matched ? Option.some({ specificity: Specificity.PORTAL, systemFamily }) : Option.none()
  }

export { recognizePortal }
