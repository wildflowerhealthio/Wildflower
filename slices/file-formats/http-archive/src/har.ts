import { HeadersWire } from 'browser-sniffer-core'
import { Schema } from 'effect'

/**
 * HAR 1.2 as a schema — the archive format itself, in both directions.
 *
 * @remarks
 * `Schema.decode` reads an archive, `Schema.encode` writes one, and
 * {@link HarFromJson} does the same from a `.har` file's text. There is no
 * separate reader and writer to drift apart, and no direction that throws:
 * malformed input is a `ParseError` like every other schema in this package.
 *
 * The encoded side is the JSON the spec describes; the type side is the same
 * structure with its values decoded — `startedDateTime` as a `DateTime.Utc`,
 * headers as the ordered pairs `HeadersWire` carries, and `content` as a
 * {@link HarBody} that says which of base64, text, or nothing the archive
 * stored. The published `har-schema` remains the authority on the encoded
 * shape; `emit.test.ts` validates against it.
 *
 * Decoding is deliberately forgiving. Fields the spec requires but an import
 * has no opinion about default rather than fail, and unknown keys are ignored —
 * which is what lets a Chrome DevTools export, with its `pages`, cookies,
 * `postData` and `_`-prefixed vendor extras, decode against this at all.
 * Encoding is canonical: it writes every field the spec requires, and a body
 * always goes out as base64.
 *
 * @packageDocumentation
 */

/** HAR's own sentinel for "not applicable, or not measured". */
const NOT_MEASURED = -1

/** HAR's `encoding` value that says `content.text` is base64 rather than text. */
const BASE64_ENCODING = 'base64'

/** A `(name, value)` pair, the shape HAR uses for headers, query params, and cookies. */
const HarNameValue = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  comment: Schema.optional(Schema.String),
})

/**
 * HAR's name/value list, read as the ordered pairs the rest of the codebase
 * speaks.
 *
 * @remarks
 * `HeadersWire` rather than a restated tuple type, for the reason
 * `TraceExchange`'s fields are imported: repeats are preserved and the shape
 * cannot drift from what the sniffer reports.
 */
const HeadersFromHarNameValues = Schema.transform(Schema.Array(HarNameValue), HeadersWire, {
  strict: true,
  decode: (pairs) => pairs.map(({ name, value }) => [name, value] as const),
  encode: (headers) => headers.map(([name, value]) => ({ name, value })),
})

/** A body stored as base64 — what this project's own exports always write. */
const HarBase64Body = Schema.TaggedStruct('HarBase64Body', { text: Schema.String })

/** A body stored as text, which a DevTools export writes for textual responses. */
const HarTextBody = Schema.TaggedStruct('HarTextBody', { text: Schema.String })

/** No body stored — a `size` with no `text`, which is not the same as an empty one. */
const HarNoBody = Schema.TaggedStruct('HarNoBody', {})

/**
 * What an archive stored for a response body.
 *
 * @remarks
 * A union rather than an optional string plus an `encoding` flag, so "stored as
 * base64", "stored as text" and "not stored" are three cases a reader has to
 * handle rather than a combination it has to reconstruct.
 */
const HarBody = Schema.Union(HarBase64Body, HarTextBody, HarNoBody)

const HarContentJson = Schema.Struct({
  size: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  mimeType: Schema.optionalWith(Schema.String, { default: () => '' }),
  text: Schema.optional(Schema.String),
  encoding: Schema.optional(Schema.String),
  comment: Schema.optional(Schema.String),
})

const HarContentDecoded = Schema.Struct({
  size: Schema.Number,
  mimeType: Schema.String,
  body: HarBody,
  comment: Schema.optional(Schema.String),
})

/** Which of base64, text, or nothing a `content` stored. */
const bodyOf = (text: string | undefined, encoding: string | undefined): typeof HarBody.Encoded => {
  if (text === undefined) {
    return { _tag: 'HarNoBody' }
  }
  return encoding === BASE64_ENCODING
    ? { _tag: 'HarBase64Body', text }
    : { _tag: 'HarTextBody', text }
}

const storedTextOf = (
  body: typeof HarBody.Type
): { readonly text?: string; readonly encoding?: string } => {
  if (body._tag === 'HarNoBody') {
    return {}
  }
  if (body._tag === 'HarBase64Body') {
    return { text: body.text, encoding: BASE64_ENCODING }
  }
  return { text: body.text }
}

/**
 * HAR `content` — the response body, or the record of one that was not stored.
 *
 * @remarks
 * Encoding always writes base64, so a text body read from a foreign archive
 * comes back out base64-encoded. That is the one place this codec normalizes
 * rather than preserves; the bytes are identical either way.
 */
const HarContent = Schema.transform(HarContentJson, HarContentDecoded, {
  strict: true,
  decode: ({ text, encoding, ...rest }): typeof HarContentDecoded.Encoded => ({
    ...rest,
    body: bodyOf(text, encoding),
  }),
  encode: ({ body, ...rest }): typeof HarContentJson.Type => ({
    ...rest,
    ...storedTextOf(body),
  }),
})

/** HAR `request`. See {@link emitHar} for why ours says so little. */
const HarRequest = Schema.Struct({
  method: Schema.optionalWith(Schema.String, { default: () => 'UNKNOWN' }),
  url: Schema.String,
  httpVersion: Schema.optionalWith(Schema.String, { default: () => '' }),
  cookies: Schema.optionalWith(Schema.Array(HarNameValue), { default: () => [] }),
  headers: Schema.optionalWith(HeadersFromHarNameValues, { default: () => [] }),
  queryString: Schema.optionalWith(Schema.Array(HarNameValue), { default: () => [] }),
  headersSize: Schema.optionalWith(Schema.Number, { default: () => NOT_MEASURED }),
  bodySize: Schema.optionalWith(Schema.Number, { default: () => NOT_MEASURED }),
  comment: Schema.optional(Schema.String),
})

/** HAR `response`. */
const HarResponse = Schema.Struct({
  // Wider than the sniffer's `[0, 1000]`: an odd status in someone else's
  // archive is a reason to import the entry as it stands, not to fail the file.
  status: Schema.Int,
  statusText: Schema.optionalWith(Schema.String, { default: () => '' }),
  httpVersion: Schema.optionalWith(Schema.String, { default: () => '' }),
  cookies: Schema.optionalWith(Schema.Array(HarNameValue), { default: () => [] }),
  headers: Schema.optionalWith(HeadersFromHarNameValues, { default: () => [] }),
  content: HarContent,
  redirectURL: Schema.optionalWith(Schema.String, { default: () => '' }),
  headersSize: Schema.optionalWith(Schema.Number, { default: () => NOT_MEASURED }),
  bodySize: Schema.optionalWith(Schema.Number, { default: () => NOT_MEASURED }),
  comment: Schema.optional(Schema.String),
})

/** HAR `timings`, in milliseconds. `-1` is the spec's "not applicable or not measured". */
const HarTimings = Schema.Struct({
  send: Schema.optionalWith(Schema.Number, { default: () => NOT_MEASURED }),
  wait: Schema.optionalWith(Schema.Number, { default: () => NOT_MEASURED }),
  receive: Schema.optionalWith(Schema.Number, { default: () => NOT_MEASURED }),
  comment: Schema.optional(Schema.String),
})

/** HAR `entry` — one exchange. */
const HarEntry = Schema.Struct({
  startedDateTime: Schema.DateTimeUtc,
  time: Schema.optionalWith(Schema.Number, { default: () => NOT_MEASURED }),
  request: HarRequest,
  response: HarResponse,
  cache: Schema.optionalWith(Schema.Struct({}), { default: () => ({}) }),
  timings: Schema.optionalWith(HarTimings, {
    default: () => ({ send: NOT_MEASURED, wait: NOT_MEASURED, receive: NOT_MEASURED }),
  }),
  comment: Schema.optional(Schema.String),
})

/** HAR `creator` — the tool that wrote the archive. */
const HarCreator = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  comment: Schema.optional(Schema.String),
})

/** HAR `log`. */
const HarLog = Schema.Struct({
  // Read, not enforced: the structure above is what an import depends on, so a
  // `1.1` archive carrying it is one this can read.
  version: Schema.optionalWith(Schema.String, { default: () => '1.2' }),
  creator: Schema.optionalWith(HarCreator, {
    default: () => ({ name: 'unknown', version: '0' }),
  }),
  entries: Schema.Array(HarEntry),
  comment: Schema.optional(Schema.String),
})

/** A complete HAR archive. */
const Har = Schema.Struct({ log: HarLog }).annotations({
  identifier: 'Har',
  description: 'A HAR 1.2 archive.',
})

/** An archive as the text of a `.har` file — invalid JSON is a `ParseError` too. */
const HarFromJson = Schema.parseJson(Har).annotations({
  identifier: 'HarFromJson',
  description: 'A HAR 1.2 archive, as the text of a .har file.',
})

type Har = typeof Har.Type
type HarBody = typeof HarBody.Type
type HarContent = typeof HarContent.Type
type HarCreator = typeof HarCreator.Type
type HarEntry = typeof HarEntry.Type
type HarLog = typeof HarLog.Type
type HarNameValue = typeof HarNameValue.Type
type HarRequest = typeof HarRequest.Type
type HarResponse = typeof HarResponse.Type
type HarTimings = typeof HarTimings.Type

export {
  BASE64_ENCODING,
  Har,
  HarBase64Body,
  HarBody,
  HarContent,
  HarCreator,
  HarEntry,
  HarFromJson,
  HarLog,
  HarNameValue,
  HarNoBody,
  HarRequest,
  HarResponse,
  HarTextBody,
  HarTimings,
  NOT_MEASURED,
}
