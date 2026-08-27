import { Option } from 'effect'

/**
 * Small builder for the URL matchers consumed by `HttpResponseKind`. The
 * hand-crafted FHIR regexes mixed several literal-vs-wildcard path segments
 * and end-of-path boundaries; this DSL keeps the surface declarative and the
 * boundary semantics named so a reader doesn't have to translate
 * `\/Patient\/[^/?#]+(?:\?|$)/` to "Patient slash any-segment then
 * end-of-path or query-start" in their head.
 *
 * A {@link make} call returns the {@link UrlMatcher} itself — the bare function
 * `(url) => Option<root>`: `Some` the scheme + authority + base-path prefix the
 * resource was served from when the URL names the resource, `None` when it does
 * not. Recognition and root are one read of one regex, so they can never
 * disagree: `Option.isSome(matcher(url))` is "does this URL name the resource?".
 *
 * The pattern is `^`-anchored and requires an `https?://` scheme: group 1
 * captures `https?://<authority><base path>`, then the declared segments and
 * the end boundary follow. The base path is optional and non-greedy because
 * real FHIR servers mount the resource tree under a prefix (`/baseR4`,
 * `/fhir/R4`, `/interconnect-fhir-oauth/api/FHIR/R4`), so the declared
 * segments match as a suffix of the path rather than directly under the
 * origin root, and the *shortest* base path that lets them match wins. This
 * is deliberately the same shape a `SourceIdentity` keys under, so a match
 * yields both the recognition decision and the root a resource is adopted
 * beneath from one place.
 *
 * Requiring a scheme is a deliberate tightening: a non-`http(s)` or
 * scheme-less URL now returns `None`, because a root has to be a URL a
 * `SourceIdentity` can key under, which a non-HTTP scheme is not.
 *
 * Import callers use the file as a namespace:
 * `import { UrlMatch } from 'http-extraction-fundamentals'` →
 * `UrlMatch.make({...})`, `UrlMatch.literal(...)`, `UrlMatch.id`.
 *
 * @example
 * ```ts
 * const patientUrl = UrlMatch.make({
 *   segments: [UrlMatch.literal('Patient'), UrlMatch.id],
 * })
 * patientUrl('https://ehr/Patient/1')          // Some('https://ehr')
 * patientUrl('https://ehr/baseR4/Patient/1')   // Some('https://ehr/baseR4')
 * patientUrl('https://ehr/Patient/1?_x=json')  // Some('https://ehr')
 * patientUrl('https://ehr/Patient/1/_history') // None
 * patientUrl('https://ehr/Observation/2')      // None
 * patientUrl('https://Patient/123')            // None (host is not a segment)
 * patientUrl('ftp://ehr/Patient/1')            // None (scheme required)
 *
 * const observationListUrl = UrlMatch.make({
 *   segments: [UrlMatch.literal('Observation')],
 *   end: 'mustHaveQuery',
 * })
 * observationListUrl('https://ehr/Observation?subject=…') // Some('https://ehr')
 * observationListUrl('https://ehr/Observation/123')       // None
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
 * A URL recognizer: `Some` the `https?://<authority><base path>` prefix `url`
 * was served from when `url` names the resource, `None` when it names no such
 * resource (or is not `http(s)`). Recognition and root are the one read.
 */
type UrlMatcher = (url: string) => Option.Option<string>

/**
 * Build a {@link UrlMatcher} from `https?://<authority><base path>` (captured
 * as the root) followed by the supplied path segments and end-of-path
 * boundary. Compose segments with {@link literal} and {@link id}.
 */
const make = (config: {
  readonly segments: readonly PathSegment[]
  readonly end?: PathEnd
}): UrlMatcher => {
  const segments = config.segments.map(segmentPattern).join('')
  const end = endPattern(config.end ?? 'pathEnd')
  // Group 1 is the root: `https?://` (scheme required — a root must be a URL a
  // `SourceIdentity` keys under) then the authority `[^/]+` (greedy, stops at
  // the first `/`, so the host is never mistaken for a segment —
  // `https://Observation/123` does not match a `/Observation` segment), then
  // an arbitrary base path before the first declared segment; FHIR servers
  // commonly mount under `/baseR4`, `/fhir/R4`,
  // `/interconnect-fhir-oauth/api/FHIR/R4`, etc. Non-greedy so the SHORTEST
  // base path that still lets the declared segments match wins, preserving
  // the `pathEnd`/`mustHaveQuery` disjointness (a single-resource
  // `/Observation/<id>` never gets re-read as a base path that makes the list
  // `/Observation?` match). `^`-anchored so the capture starts at the scheme.
  const pattern = new RegExp(`^(https?://[^/]+(?:/[^/?#]+)*?)${segments}${end}`)
  return (url: string): Option.Option<string> => {
    const match = pattern.exec(url)
    return match?.[1] === undefined ? Option.none() : Option.some(match[1])
  }
}

export { id, literal, make }
export type { PathEnd, PathSegment, UrlMatcher }
