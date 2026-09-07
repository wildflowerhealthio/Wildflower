// oxlint-disable import/group-exports
import { Match, Option, Predicate } from 'effect'

import type { HttpMethod } from './http-method.ts'

/**
 * Small builder for the URL matchers consumed by `HttpResponseKind`. The DSL
 * keeps the surface declarative and the boundary semantics named, so a reader
 * doesn't translate `\/Patient\/[^/?#]+(?:\?|$)/` in their head — and a
 * {@link make} call returns the {@link UrlMatcher} function itself, whose one
 * regex read yields both the recognition decision and the captured root, so
 * the two can never disagree.
 *
 * A matcher also states the HTTP verbs its URL is served under. The verb
 * check runs first and short-circuits: a request whose method is not one of
 * the declared verbs (or whose method is not known — an `Option.none()` from
 * a HAR-`'UNKNOWN'` entry) returns `None` regardless of the URL. `verb` is
 * required — every kind is served under some verb, so leaving it unstated
 * would be an under-specification.
 *
 * @example
 * ```ts
 * const patientUrl = UrlMatch.make({
 *   verb: ['GET'],
 *   segments: [UrlMatch.literal('Patient'), UrlMatch.id],
 * })
 * patientUrl('https://ehr/Patient/1', Option.some('GET'))   // Some('https://ehr')
 * patientUrl('https://ehr/Patient/1', Option.some('POST'))  // None (verb rejected)
 * patientUrl('https://ehr/Patient/1', Option.none())        // None (method absent)
 * patientUrl('https://ehr/baseR4/Patient/1', Option.some('GET'))  // Some('https://ehr/baseR4')
 * patientUrl('https://ehr/Observation/2', Option.some('GET'))     // None
 *
 * const observationListUrl = UrlMatch.make({
 *   verb: ['GET'],
 *   segments: [UrlMatch.literal('Observation')],
 *   end: 'mustHaveQuery',
 * })
 * observationListUrl('https://ehr/Observation?subject=…', Option.some('GET')) // Some('https://ehr')
 * observationListUrl('https://ehr/Observation/123', Option.some('GET'))       // None
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
 * was served from when `url` names the resource AND `method` is one of the
 * declared verbs, `None` otherwise. `method` is `Option.none()` when the
 * source archive dropped it (HAR `'UNKNOWN'`); a matcher never claims a
 * request whose method it does not know.
 */
type UrlMatcher = (url: string, method: Option.Option<HttpMethod>) => Option.Option<string>

namespace Config {
  export interface Config {
    readonly verb: readonly [HttpMethod, ...HttpMethod[]]
    readonly segments: readonly PathSegment[]
    readonly end?: PathEnd
  }

  const makeHttpMethodIncludedPredicate =
    (config: Config) =>
    (method: HttpMethod): boolean =>
      config.verb.includes(method)

  export const makeHttpMethodPredicate = (
    config: Config
  ): Predicate.Refinement<Option.Option<HttpMethod>, Option.Some<HttpMethod>> => {
    const isHttpMethodIncluded = makeHttpMethodIncludedPredicate(config)
    return Predicate.compose(Option.isSome<HttpMethod>, ({ value }) => isHttpMethodIncluded(value))
  }

  export const makeBaseUrlExtractor = (config: Config): ((url: string) => string | undefined) => {
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

    return (url) => pattern.exec(url)?.[1]
  }
}

/**
 * Build a {@link UrlMatcher} from a required non-empty `verb` list, the
 * supplied path segments, and an end-of-path boundary. Compose segments with
 * {@link literal} and {@link id}. The verb list gates the URL regex — a
 * `method` not in `verb`, or an `Option.none()`, short-circuits to `None`.
 */
const make = (config: Config.Config): UrlMatcher => {
  const methodMatchesConfig = Config.makeHttpMethodPredicate(config)
  const tryExtractBaseUrl = Config.makeBaseUrlExtractor(config)

  return (url, maybeMethod) =>
    Match.value({ maybeMethod, baseUrl: tryExtractBaseUrl(url) }).pipe(
      Match.when({ maybeMethod: methodMatchesConfig, baseUrl: Predicate.isString }, ({ baseUrl }) =>
        Option.some(baseUrl)
      ),
      Match.orElse(() => Option.none())
    )
}

export { id, literal, make }
export type { PathEnd, PathSegment, UrlMatcher }
