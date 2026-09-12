import type * as HttpResponse from './http-response.ts'

/** RFC 9110's default for an entity whose `Content-Type` the server did not state. */
const UNKNOWN_CONTENT_TYPE = 'application/octet-stream'

/**
 * The response's `Content-Type`, lower-cased with its parameters stripped.
 *
 * @param headers - The response headers as received
 * @returns The bare media type, or {@link UNKNOWN_CONTENT_TYPE} when absent or blank
 *
 * @remarks
 * Header names are matched case-insensitively (HTTP does not fix their case,
 * and a sniffer forwards what arrived) and parameters are dropped, so
 * `application/json; charset=utf-8` and `application/json` are one content
 * type. The *media type* keeps its full `type/subtype+suffix` form, which is
 * what {@link isOmittedContentType} and any allowlist matcher need. The first
 * `Content-Type` wins; a response carrying two is malformed, and the answer
 * states the one a parser would have used.
 */
const contentTypeOf = (headers: HttpResponse.Headers): string => {
  const header = headers.find(([name]) => name.toLowerCase() === 'content-type')
  const mediaType = header?.[1].split(';')[0]?.trim().toLowerCase()
  return mediaType === undefined || mediaType === '' ? UNKNOWN_CONTENT_TYPE : mediaType
}

/**
 * The exact media types dropped by {@link isOmittedContentType} — script and
 * stylesheet payloads.
 *
 * @remarks
 * The JavaScript entries are the HTML Standard's "JavaScript MIME type" list in
 * full, legacy spellings included: a portal serving `text/jscript` is serving a
 * script, and a rule knowing only the two modern spellings would record it.
 */
const OMITTED_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/css',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
])

/**
 * The top-level types dropped wholesale by {@link isOmittedContentType} —
 * every subtype of each, present and future.
 */
const OMITTED_TYPE_PREFIXES: readonly string[] = ['audio/', 'font/', 'image/', 'video/']

/**
 * Whether a response with these headers is page furniture rather than
 * evidence — a script, a stylesheet, an image, a font, audio, or video.
 *
 * @param headers - The response headers as received
 * @returns `true` when the response should be dropped entirely
 *
 * @remarks
 * The one omit rule, shared so that every recorder applies it identically: a
 * collector run's recorder and the browser extension must agree on what a
 * recording contains, or a recording made by one is not comparable to a
 * recording made by the other. Omitted means *dropped* — no entry at all, not
 * an entry with the body elided — which is why this is a predicate over
 * headers rather than a body policy.
 *
 * Two consequences worth stating. The match is on the response's own content
 * type and never the URL, because a portal is free to serve anything from any
 * path: a `.js` URL served as `application/json` is recorded, a `/api/config`
 * URL served as `text/javascript` is dropped. And a response with no
 * `Content-Type` reads as {@link UNKNOWN_CONTENT_TYPE} and is *kept* — an
 * unlabelled body is exactly where dropping would lose evidence.
 */
const isOmittedContentType = (headers: HttpResponse.Headers): boolean => {
  const contentType = contentTypeOf(headers)
  return (
    OMITTED_MEDIA_TYPES.has(contentType) ||
    OMITTED_TYPE_PREFIXES.some((prefix) => contentType.startsWith(prefix))
  )
}

export { contentTypeOf, isOmittedContentType, UNKNOWN_CONTENT_TYPE }
