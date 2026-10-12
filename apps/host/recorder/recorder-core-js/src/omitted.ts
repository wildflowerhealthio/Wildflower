/**
 * What a recording leaves out: the presentation assets a reader of the archive
 * never wants and that would otherwise dominate the file.
 *
 * @packageDocumentation
 */

/** Top-level media types dropped wholesale: the assets a page loads to render itself. */
const OMITTED_TYPES: ReadonlySet<string> = new Set(['image', 'video', 'audio', 'font'])

/**
 * The individually named media types dropped: stylesheets and every spelling of
 * the JavaScript MIME type the HTML Standard recognises (plus the legacy ones
 * browsers still honour). They are text, so a `text/*` rule would be wrong
 * here, and they carry nothing a reader of a recording is after.
 */
const OMITTED_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'text/css',
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
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
 * Whether a response with this content type is left out of a recording.
 *
 * @param contentType - A bare media type as `contentTypeOf` yields it:
 *   lower-cased, parameters stripped (`application/json`, not
 *   `application/json; charset=utf-8`)
 * @returns `true` for `text/css`, every standard and legacy JavaScript MIME
 *   type, and any `image/*`, `video/*`, `audio/*` or `font/*`; `false` for
 *   everything else, including an absent content type (which arrives as
 *   `application/octet-stream`)
 *
 * @remarks
 * A denylist, deliberately: the failure mode that matters for a recording is a
 * missing exchange, not an extra one.
 *
 * **JavaScript is omitted.** The full HTML Standard "JavaScript MIME type" list
 * (plus legacy spellings browsers still honour) is dropped — bundles and inline
 * scripts dominate a recording's size while rarely carrying the information a
 * reader is after. This aligns with `http-extraction-fundamentals`'
 * `isOmittedContentType`; the two predicates still live separately — do not
 * collapse them, and do not import that one here.
 */
const isOmittedFromRecording = (contentType: string): boolean => {
  if (OMITTED_MEDIA_TYPES.has(contentType)) return true
  const [type] = contentType.split('/')
  return type !== undefined && OMITTED_TYPES.has(type)
}

export { isOmittedFromRecording }
