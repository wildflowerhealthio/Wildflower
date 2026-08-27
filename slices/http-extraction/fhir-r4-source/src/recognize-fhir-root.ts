import { Option, pipe } from 'effect'
import { type RecognizedUrlData, Specificity, type UrlMatch } from 'http-extraction-fundamentals'

/**
 * Turn a fused {@link UrlMatch.UrlMatcher} into the FHIR kind's `tryRecognize`:
 * `Some` a protocol-tier {@link RecognizedUrlData} whose `source` is the root
 * the matcher captured (as **both** `system` and `baseUrl`, because a FHIR
 * server spells its own references absolutely under that same prefix), `None`
 * when the matcher does not claim the URL.
 *
 * @param matcher - The kind's own URL matcher (its recognition *and* its root,
 *   fused into one pattern)
 * @returns The `tryRecognize` the kind exposes
 *
 * @remarks
 * The root a resource is keyed under comes straight from the matcher's capture,
 * so there is no second hand-written root regex to keep in step. Every FHIR
 * kind sits at {@link Specificity.PROTOCOL} — the protocol-generic middle rung,
 * below a named portal and above the catch-all recorder.
 */
const recognizeFhirRoot =
  (matcher: UrlMatch.UrlMatcher): ((url: string) => Option.Option<RecognizedUrlData>) =>
  (url) =>
    pipe(
      matcher(url),
      Option.map((root) => ({
        specificity: Specificity.PROTOCOL,
        source: { system: root, baseUrl: root },
      }))
    )

export { recognizeFhirRoot }
