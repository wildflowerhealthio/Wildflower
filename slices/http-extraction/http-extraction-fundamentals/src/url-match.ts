import { Option } from 'effect'

/**
 * Small builder for the URL matchers consumed by `HttpResponseKind`. The DSL
 * keeps the surface declarative and the boundary semantics named, so a reader
 * doesn't translate `\/Patient\/[^/?#]+(?:\?|$)/` in their head — and a
 * {@link make} call returns the {@link UrlMatcher} function itself, whose one
 * regex read yields both the recognition decision and the captured root, so
 * the two can never disagree.
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
  // Group 1 is the root: `https?://` (scheme required — a root must be a URL
  // a `SourceIdentity` keys under), the authority `[^/]+` (stops at the first
  // `/`, so a host is never mistaken for a segment), then an arbitrary base
  // path — FHIR servers commonly mount under `/baseR4`, `/fhir/R4`, etc.
  // Non-greedy so the SHORTEST base path that still lets the declared segments
  // match wins, preserving `pathEnd`/`mustHaveQuery` disjointness (a
  // single-resource `/Observation/<id>` never re-reads as a base path that
  // makes the list `/Observation?` match). `^`-anchored so the capture starts
  // at the scheme.
  const pattern = new RegExp(`^(https?://[^/]+(?:/[^/?#]+)*?)${segments}${end}`)
  return (url: string): Option.Option<string> => {
    const match = pattern.exec(url)
    return match?.[1] === undefined ? Option.none() : Option.some(match[1])
  }
}

export { id, literal, make }
export type { PathEnd, PathSegment, UrlMatcher }
