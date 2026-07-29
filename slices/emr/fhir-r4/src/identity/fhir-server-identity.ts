import { Effect, Either, ParseResult, type SchemaAST } from 'effect'

import { parseWithSourceIdentity, type SourceKeyedResource } from './adopt-source-identity.ts'
import type { SourceIdentity } from './source-identity.ts'

/**
 * Reading a FHIR server's identity off the URL a response came back from.
 *
 * @packageDocumentation
 *
 * @remarks
 * A collector reading a real FHIR server answers "whose ids are these?" with
 * the **service base URL** — the prefix everything after `Type/id` hangs off.
 * Recovering it is FHIR's RESTful URL scheme rather than any one collector's
 * business, so it lives here beside the derivation: the second collector would
 * otherwise copy it, and a copy that drifts splits one server into two
 * namespaces.
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
 * Split path segments with any trailing empties — one or more trailing slashes
 * — removed, so the count that follows measures segments rather than slashes.
 *
 * @param segments - `url.pathname.split('/')`
 * @returns The same segments up to the last non-empty one
 *
 * @remarks
 * A path of nothing but empties is returned untouched: `'/'` splits to
 * `['', '']`, and trimming that to `[]` would make a root-mounted server's base
 * depend on how many slashes the URL happened to carry. Interior empties (a
 * `//` mid-path) are left alone — those are segments a server may genuinely
 * serve, not punctuation at the end.
 */
const withoutTrailingSlash = (segments: readonly string[]): readonly string[] => {
  const last = segments.findLastIndex((segment) => segment !== '')
  return last === -1 ? segments : segments.slice(0, last + 1)
}

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
 * `subject: 'Patient/123'` derive the very id the `Patient` was stored under.
 *
 * The shape comes from the caller because the path alone does not determine it.
 * Recognizing the resource type by its capitalized-letters shape looks reliable
 * — every base-path segment in the wild (`/baseR4`, `/fhir/R4`,
 * `/interconnect-fhir-oauth/api/FHIR/R4`) is lowercase or mixed with digits —
 * but ids are not: `Patient/JohnDoe`'s _id_ is type-shaped, and reading it as
 * the type puts that one resource in a namespace of its own, with a dangling
 * `subject` as the only symptom. A property test caught it; the calling entity
 * already knows which pattern it matched.
 *
 * A trailing slash is dropped before the count, because `…/Patient/?_count=250`
 * splits to one segment more than `…/Patient?_count=250` and would otherwise
 * reduce to `…/baseR4/Patient` — the resource type left standing as part of the
 * base, i.e. the dangling-`subject` failure above, from a URL naming the very
 * collection the spelling beside it names.
 *
 * Defence in depth rather than a live fix: no collector reaches here with one
 * today, because `UrlMatch`'s `mustHaveQuery` boundary wants the `?` directly
 * after the type and its `pathEnd` boundary admits no second slash, so
 * `isFoundAt` rejects both that URL and `…/Patient/1/_history/2` before `parse`
 * runs. That is an invariant of the _caller's_ pattern, two packages away and
 * free to change; this function is exported, takes any `URL`, and should not
 * quietly depend on it.
 */
const fhirServiceBase = (url: URL, shape: FhirUrlShape): URL => {
  const segments = withoutTrailingSlash(url.pathname.split('/'))
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
 * An `Either` rather than a throw: a response URL reaches a collector from an
 * untyped path, and a `new URL` throw inside `parse` would surface as a defect,
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
 * with this and states nothing beyond its prefix and URL shape. Both failures
 * are environment-level rather than per-resource (no Web Crypto, or a response
 * URL that is not a URL), so both fail the one parse — see
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
