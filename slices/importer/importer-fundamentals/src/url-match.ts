/**
 * Small builder for the URL-recognition regexes consumed by
 * `EntityDefinition.isFoundAt`. The hand-crafted FHIR regexes mixed
 * several literal-vs-wildcard path segments and end-of-path
 * boundaries; this DSL keeps the surface declarative and the
 * boundary semantics named so a reader doesn't have to translate
 * `\/Patient\/[^/?#]+(?:\?|$)/` to "Patient slash any-segment then
 * end-of-path or query-start" in their head.
 *
 * The produced `RegExp` is intentionally *unanchored* on both sides:
 * a typical URL has a scheme prefix and a trailing path/query the
 * entity doesn't care about. The pattern starts with `://[^/]+` so
 * an HTTP/HTTPS scheme + host has to lead the match, followed by an
 * optional base path — real FHIR servers mount the resource tree
 * under a prefix (`/baseR4`, `/fhir/R4`, `/interconnect-fhir-oauth/api/FHIR/R4`),
 * so the declared segments match as a suffix of the path rather than
 * directly under the origin root.
 *
 * Import callers use the file as a namespace:
 * `import { UrlMatch } from 'importer-fundamentals'` →
 * `UrlMatch.make({...})`, `UrlMatch.literal(...)`, `UrlMatch.id`.
 *
 * @example
 * ```ts
 * const PatientUrl = UrlMatch.make({
 *   segments: [UrlMatch.literal('Patient'), UrlMatch.id],
 * })
 * PatientUrl.test('https://r4/Patient/123')              // true
 * PatientUrl.test('https://r4/Patient/123?_format=json') // true
 * PatientUrl.test('https://r4/fhir/R4/Patient/123')      // true (base path)
 * PatientUrl.test('https://r4/Patient/123/_history')     // false
 * PatientUrl.test('https://r4/Observation/123')          // false
 * PatientUrl.test('https://Patient/123')                 // false (host is not a segment)
 *
 * const ObservationListUrl = UrlMatch.make({
 *   segments: [UrlMatch.literal('Observation')],
 *   end: 'mustHaveQuery',
 * })
 * ObservationListUrl.test('https://r4/Observation?subject=…')      // true
 * ObservationListUrl.test('https://r4/baseR4/Observation?subject=…') // true (base path)
 * ObservationListUrl.test('https://r4/Observation/123')            // false
 * ```
 */

type PathSegment = { readonly _tag: 'Literal'; readonly value: string } | { readonly _tag: 'Id' }

/** A literal URL path segment (e.g. `Patient`, `Observation`). */
const literal = (value: string): PathSegment => ({ _tag: 'Literal', value })

/**
 * A wildcard segment matching one path component that doesn't
 * contain `/`, `?`, or `#`. Keeps query strings and fragments out
 * of the captured "id" portion (older regexes used `[^/]+` which
 * silently swallowed `?_format=json`).
 */
const id: PathSegment = { _tag: 'Id' }

/**
 * Boundary at the end of the matched path:
 * - `pathEnd` (default): the URL ends here or the next character is
 *   `?` (the query separator). Matches `…/Patient/123` and
 *   `…/Patient/123?_format=json`.
 * - `mustHaveQuery`: the URL must continue with `?`. Use this to
 *   make a list-by-query regex (`…/Observation?…`) disjoint from a
 *   single-resource regex (`…/Observation/123`).
 */
type PathEnd = 'pathEnd' | 'mustHaveQuery'

const escapeForRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const segmentPattern = (s: PathSegment): string =>
  s._tag === 'Literal' ? `/${escapeForRegExp(s.value)}` : `/[^/?#]+`

const endPattern = (e: PathEnd): string => (e === 'mustHaveQuery' ? '\\?' : '(?:\\?|$)')

/**
 * Build a `RegExp` matching `://host` followed by the supplied
 * path segments and end-of-path boundary. Compose segments with
 * {@link literal} and {@link id}.
 */
const make = (config: {
  readonly segments: readonly PathSegment[]
  readonly end?: PathEnd
}): RegExp => {
  const segments = config.segments.map(segmentPattern).join('')
  const end = endPattern(config.end ?? 'pathEnd')
  // Authority is `://[^/]+` (greedy, stops at the first `/`, so the host
  // is never mistaken for a segment — `https://Observation/123` does not
  // match a `/Observation` segment). Then allow an arbitrary base path
  // before the first declared segment; FHIR servers commonly mount under
  // `/baseR4`, `/fhir/R4`, `/interconnect-fhir-oauth/api/FHIR/R4`, etc.
  // Non-greedy so the SHORTEST base path that still lets the declared
  // segments match wins, preserving the `pathEnd`/`mustHaveQuery`
  // disjointness (a single-resource `/Observation/<id>` never gets
  // re-read as a base path that makes the list `/Observation?` match).
  const basePath = '(?:/[^/?#]+)*?'
  return new RegExp(`://[^/]+${basePath}${segments}${end}`)
}

export { id, literal, make }
export type { PathEnd, PathSegment }
