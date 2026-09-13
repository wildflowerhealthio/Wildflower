/**
 * What a recording leaves out: the presentation assets a reader of the archive
 * never wants and that would otherwise dominate the file.
 *
 * @packageDocumentation
 */

/**
 * The top-level media types dropped wholesale — the binary assets a page loads
 * to render itself.
 */
const OMITTED_TYPES: ReadonlySet<string> = new Set(['image', 'video', 'audio', 'font'])

/**
 * The individually named media types dropped. Stylesheets only: they are text,
 * so a `text/*` rule would be wrong here, and they carry nothing a reader of a
 * recording is after.
 */
const OMITTED_MEDIA_TYPES: ReadonlySet<string> = new Set(['text/css'])

/**
 * Whether a response with this content type is left out of a recording.
 *
 * @param contentType - A bare media type as `contentTypeOf` yields it:
 *   lower-cased, parameters stripped (`application/json`, not
 *   `application/json; charset=utf-8`)
 * @returns `true` for `text/css` and any `image/*`, `video/*`, `audio/*` or
 *   `font/*`; `false` for everything else, including an absent content type
 *   (which arrives as `application/octet-stream`)
 *
 * @remarks
 * A denylist rather than an allowlist, deliberately: a recording's job is to
 * capture what a page actually did, and the failure mode that matters is a
 * missing exchange, not an extra one. What is named here is what nobody reads a
 * recording for.
 *
 * **JavaScript is kept.** This diverges on purpose from
 * `http-extraction-fundamentals`' `isOmittedContentType` (arriving with
 * PR #651, epic #578), which also omits JavaScript. That predicate serves an
 * extraction pipeline, where a bundle is noise; this one serves a recording a
 * human or an agent reads to work out how a portal behaves, and the answer is
 * frequently *in* the bundle. The two predicates stay separate permanently —
 * do not collapse them, and do not import that one here.
 *
 * The cap on body size ({@link MAX_BODY_BYTES}) is what keeps a kept-but-huge
 * bundle from dominating the file; this predicate does not look at size.
 */
const isOmittedFromRecording = (contentType: string): boolean => {
  if (OMITTED_MEDIA_TYPES.has(contentType)) return true
  const [type] = contentType.split('/')
  return type !== undefined && OMITTED_TYPES.has(type)
}

export { isOmittedFromRecording }
