import { Schema } from 'effect'
import type { Attachment } from 'fhir-r4/data-types'
import type { TraceBody } from 'web-trace-core'

/**
 * The one shape the generic attachment viewer renders, and the adapters into it.
 *
 * @remarks
 * Two callers feed the viewer: the recordings tab, which holds a `TraceBody`,
 * and the documents browser, which holds a FHIR `Attachment`. Neither type can
 * serve as the viewer's input on its own — `SkippedBody.reason` has no slot in
 * `Attachment`, and `Attachment.url` (content held elsewhere) has no counterpart
 * in `TraceBody`. So the viewer takes {@link ViewableAttachment} and each caller
 * adapts into it, which is what lets one viewer serve both tabs.
 *
 * Nothing here redacts. The viewer shows captured bytes as they were recorded.
 *
 * @packageDocumentation
 */

/**
 * Why an attachment's bytes are not present.
 *
 * @remarks
 * Modelled rather than collapsed to a boolean: "the capture declined to store
 * this" and "the server holds this elsewhere" are different facts about
 * different things, and an empty attachment is a third. Rendering all three as
 * "no body" would make the viewer claim something the record does not say.
 */
type AttachmentAbsence =
  /** The capture policy declined to store the bytes, for the stated reason. */
  | { readonly _tag: 'SkippedAtCapture'; readonly reason: string }
  /** The content lives at a URL rather than inline. */
  | { readonly _tag: 'ByReference'; readonly url: string }
  /** Neither inline data nor a URL — the record carries no content at all. */
  | { readonly _tag: 'Empty' }

/** What the generic attachment viewer renders. */
interface ViewableAttachment {
  /** The recorded media type, or `''` when none was recorded. */
  readonly contentType: string
  /** Base64 of the bytes, or `null` when they are absent — see {@link ViewableAttachment.absence}. */
  readonly data: string | null
  /** Byte length of the content, or `null` when unrecorded. */
  readonly size: number | null
  /** Base64 SHA-256 of the content (FHIR `Attachment.hash`), or `null`. */
  readonly hash: string | null
  /** A label for the content — the request URL for a trace body. */
  readonly title: string | null
  /** Why {@link ViewableAttachment.data} is `null`, or `null` when it is not. */
  readonly absence: AttachmentAbsence | null
}

/**
 * Adapts a captured response body into the viewer's shape.
 *
 * @param body - The exchange's body, stored or skipped
 * @param title - A label for the content, typically the request URL
 * @returns The attachment to render
 */
const fromTraceBody = (body: TraceBody, title: string | null = null): ViewableAttachment =>
  body._tag === 'StoredBody'
    ? {
        contentType: body.contentType,
        data: body.data,
        size: body.size,
        hash: body.hash,
        title,
        absence: null,
      }
    : {
        contentType: body.contentType,
        data: null,
        size: body.size,
        hash: body.hash,
        title,
        absence: { _tag: 'SkippedAtCapture', reason: body.reason },
      }

/**
 * Adapts a decoded FHIR `Attachment` into the viewer's shape.
 *
 * @param attachment - Any decoded `Attachment`
 * @returns The attachment to render
 *
 * @remarks
 * An attachment with no inline `data` but a `url` is by reference, not empty.
 * The viewer does not fetch it — that would be network egress, which this app
 * does not do — so it names the location and stops there.
 */
const fromFhirAttachment = (attachment: typeof Attachment.Schema.Type): ViewableAttachment => {
  const url = attachment.url === null ? null : attachment.url.toString()
  const absenceOf = (): AttachmentAbsence | null => {
    if (attachment.data !== null) return null
    return url === null ? { _tag: 'Empty' } : { _tag: 'ByReference', url }
  }
  return {
    contentType: attachment.contentType ?? '',
    data: attachment.data,
    size: attachment.size,
    hash: attachment.hash,
    title: attachment.title,
    absence: absenceOf(),
  }
}

/** How the viewer can render an attachment's bytes. */
type PreviewKind = 'json' | 'text' | 'image' | 'none'

const decodeBase64 = Schema.decodeSync(Schema.StringFromBase64)

/** The media type alone, lower-cased — the same normalisation the list filter uses. */
const mediaTypeOf = (contentType: string): string =>
  (contentType.split(';')[0] ?? '').trim().toLowerCase()

const TEXTUAL_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application/javascript',
  'application/ecmascript',
  'application/x-www-form-urlencoded',
  'application/xml',
  'application/xhtml+xml',
])

/**
 * Media types that look renderable but must never be rendered.
 *
 * @remarks
 * Checked before every other rule, so no later reordering can promote one of
 * these to `image`. An SVG is a document that can carry script and remote
 * references; rendering a captured one would execute whatever the recorded page
 * served, against the viewer's own origin.
 */
const NEVER_RENDERED_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/svg+xml', 'image/svg'])

/**
 * How a body of this content type can be shown.
 *
 * @param contentType - The recorded media type, with or without parameters
 * @returns `json` for JSON and `+json` types, `text` for textual types,
 *   `image` for raster images, `none` when the bytes cannot be shown usefully
 *
 * @remarks
 * {@link NEVER_RENDERED_MEDIA_TYPES} is consulted first, so an SVG is `text` no
 * matter how the rules below are later reordered. Showing its markup tells a
 * collector author what the endpoint served without running it.
 *
 * An unrecognised type is `none` rather than a guess — the capture stores bodies
 * of any type, and rendering arbitrary bytes as text produces noise that reads
 * like data.
 */
const previewKindFor = (contentType: string): PreviewKind => {
  const mediaType = mediaTypeOf(contentType)
  if (NEVER_RENDERED_MEDIA_TYPES.has(mediaType)) return 'text'
  if (mediaType === 'application/json' || mediaType === 'text/json') return 'json'
  if (mediaType.endsWith('+json')) return 'json'
  if (TEXTUAL_MEDIA_TYPES.has(mediaType)) return 'text'
  if (mediaType.endsWith('+xml')) return 'text'
  if (mediaType.startsWith('text/')) return 'text'
  if (mediaType.startsWith('image/')) return 'image'
  return 'none'
}

/**
 * Decodes base64 content to text.
 *
 * @param data - Base64 of the recorded bytes
 * @returns The decoded text, or `null` when the value is not decodable base64
 *
 * @remarks
 * Returns `null` rather than raising: a body that does not decode is a fact to
 * render, not a reason to fail the whole detail view.
 */
const decodeText = (data: string): string | null => {
  try {
    return decodeBase64(data)
  } catch {
    return null
  }
}

/**
 * Pretty-prints JSON text, falling back to the text itself.
 *
 * @param text - The decoded body text
 * @returns The re-indented JSON, or `text` unchanged when it does not parse
 *
 * @remarks
 * A body labelled JSON that is not JSON still renders — as itself. Showing
 * nothing, or an error in place of the content, would hide exactly the mismatch
 * a collector author needs to see.
 */
const formatJson = (text: string): string => {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2)
  } catch {
    return text
  }
}

/**
 * The `data:` URI for an image attachment.
 *
 * @param attachment - The attachment being rendered
 * @returns A same-document data URI
 *
 * @remarks
 * A data URI, never a network fetch: no network egress at any point is the
 * premise of the app, so the bytes render from what is already in the page.
 */
const imageDataUri = (attachment: ViewableAttachment): string =>
  `data:${mediaTypeOf(attachment.contentType)};base64,${attachment.data ?? ''}`

export {
  type AttachmentAbsence,
  decodeText,
  formatJson,
  fromFhirAttachment,
  fromTraceBody,
  imageDataUri,
  mediaTypeOf,
  type PreviewKind,
  previewKindFor,
  type ViewableAttachment,
}
