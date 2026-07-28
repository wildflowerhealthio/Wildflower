import { Effect, Either, ParseResult, type SchemaAST } from 'effect'

import { parseWithSourceIdentity, type SourceKeyedResource } from './adopt-source-identity.ts'
import type { SourceIdentity } from './source-identity.ts'

/**
 * Reading a FHIR server's identity off the URL a response came back from.
 *
 * @packageDocumentation
 *
 * @remarks
 * A collector reading a real FHIR server has to answer "whose ids are these?"
 * before it can re-key anything, and the answer is the **service base URL** —
 * the prefix everything after `Type/id` hangs off. Recovering it is FHIR's
 * RESTful URL scheme rather than any one collector's business, which is why it
 * lives here beside the derivation instead of in the first collector that
 * needed it: the second one would have copied it, and a copy that drifts
 * silently splits one server into two namespaces.
 */

/**
 * Which of FHIR's two read URL shapes a response came back from.
 *
 * @remarks
 * `'instance'` is `…/<base>/Type/id`; `'search'` is `…/<base>/Type?…`. The two
 * differ only in how many trailing segments stand between the base and the end
 * of the path, which is the whole of what {@link fhirServiceBase} needs.
 */
type FhirUrlShape = 'instance' | 'search'

/** How many trailing path segments each shape puts after the service base. */
const TRAILING_SEGMENTS: Record<FhirUrlShape, number> = { instance: 2, search: 1 }

/**
 * The FHIR service base URL a request was made against.
 *
 * @param url - The full response URL
 * @param shape - Which read shape the caller recognized
 * @returns The same origin and base path, with the resource type, id, and query
 *   removed
 *
 * @remarks
 * `…/baseR4/Patient/123?_format=json` and `…/baseR4/Observation?subject=…` both
 * reduce to `…/baseR4`, which is what makes an `Observation`'s
 * `subject: 'Patient/123'` derive the very id the `Patient` was stored under:
 * the two responses agree on the namespace because they agree on the server,
 * not because anything coordinated them.
 *
 * The shape is taken from the caller rather than sniffed out of the path,
 * because the path alone does not determine it. Recognizing the resource type
 * by its capitalized-letters shape looks reliable — every base-path segment in
 * the wild (`/baseR4`, `/fhir/R4`, `/interconnect-fhir-oauth/api/FHIR/R4`) is
 * lowercase or mixed with digits — but ids are not: `Patient/JohnDoe` is a
 * legal instance URL whose _id_ is type-shaped, and reading it as the type
 * would put that one resource in a namespace of its own, with a dangling
 * `subject` as the only symptom. A property test caught it; a collector's
 * entity already knows which pattern it matched, so it says.
 */
const fhirServiceBase = (url: URL, shape: FhirUrlShape): URL => {
  const segments = url.pathname.split('/')
  const base = new URL(url.href)
  base.pathname = segments
    .slice(0, Math.max(0, segments.length - TRAILING_SEGMENTS[shape]))
    .join('/')
  base.search = ''
  base.hash = ''
  return base
}

/**
 * The identity of the server that assigned the ids in one response.
 *
 * @param prefix - Names the collector in every id derived from this source
 * @param shape - Which read shape the caller recognized
 * @param responseUrl - The response's URL, as the sniffer reported it
 * @returns The source identity, or the reason its URL could not be read
 *
 * @remarks
 * Returns an `Either` rather than throwing, because a response URL reaches a
 * collector from an untyped path (the sniffer forwards what the browser said)
 * and a `new URL` throw inside an entity's `parse` would surface as a defect —
 * escaping the seam that keeps one bad response from taking a run down.
 */
const fhirServerSourceIdentity = (
  prefix: string,
  shape: FhirUrlShape,
  responseUrl: string
): Either.Either<SourceIdentity, string> =>
  Either.match(
    Either.try({
      try: () => new URL(responseUrl),
      catch: () => `not an absolute URL: ${responseUrl}`,
    }),
    {
      onLeft: Either.left,
      onRight: (url) => Either.right({ prefix, system: fhirServiceBase(url, shape) }),
    }
  )

/**
 * Re-key everything one FHIR-server response produced, onto that server's
 * namespace.
 *
 * @param prefix - Names the collector in every id it derives
 * @param shape - Which read shape the calling entity recognized
 * @param responseUrl - The response's URL, which names the server that assigned
 *   the ids being replaced
 * @param ast - The schema the entity was decoding, for the failure message
 * @param resources - The decoded resources, as the entity produced them
 * @returns The same resources, each carrying a derived id, an `Identifier`
 *   naming the server's own id, and rewritten references
 *
 * @remarks
 * The whole of a FHIR-server collector's re-keying: an entity's `parse` ends
 * with this and states nothing beyond its own prefix and URL shape. Both
 * failures are environment-level rather than per-resource (no Web Crypto, or a
 * response URL that is not a URL), so both fail the one parse — see
 * {@link parseWithSourceIdentity}.
 */
const parseWithFhirServerIdentity = <TResource extends SourceKeyedResource>(
  prefix: string,
  shape: FhirUrlShape,
  responseUrl: string,
  ast: SchemaAST.AST,
  resources: readonly TResource[]
): Effect.Effect<readonly TResource[], ParseResult.ParseError> =>
  Either.match(fhirServerSourceIdentity(prefix, shape, responseUrl), {
    onLeft: (reason) =>
      Effect.fail(
        new ParseResult.ParseError({
          issue: new ParseResult.Forbidden(
            ast,
            responseUrl,
            `Could not tell which FHIR server assigned these ids: ${reason}`
          ),
        })
      ),
    onRight: (source) => parseWithSourceIdentity(source, ast, resources),
  })

export { fhirServerSourceIdentity, fhirServiceBase, type FhirUrlShape, parseWithFhirServerIdentity }
