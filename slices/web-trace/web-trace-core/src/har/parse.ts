import { HeadersWire } from 'browser-sniffer-core'
import { Either, Encoding, ParseResult, Schema } from 'effect'

/**
 * HAR 1.2 parsing — the inverse of `emit.ts`, and the front door of the importer.
 *
 * @remarks
 * The emitter writes archives this project produced; this reads archives anyone
 * produced, a Chrome DevTools export first of all. Parsing is a schema, like the
 * codec, so failure is a `ParseError` and malformed input never throws. The
 * package [AGENTS.md](../../AGENTS.md) states what that costs and constrains.
 *
 * @packageDocumentation
 */

/** Prefix of a {@link ParsedHarEntry}'s synthesized id. */
const HAR_ENTRY_ID_PREFIX = 'har-entry-'

/** HAR's `encoding` value that says `content.text` is base64 rather than text. */
const BASE64_ENCODING = 'base64'

const utf8 = new TextEncoder()

/** A `(name, value)` pair as HAR spells one. */
const HarNameValueWire = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
})

/**
 * HAR `content` — the response body, or the record of one that was not stored.
 *
 * @remarks
 * `size` and `mimeType` are spec-required but unread here, so they go unnamed:
 * every field named is another way for a real archive to be rejected over
 * something an import does not consume.
 */
const HarContentWire = Schema.Struct({
  text: Schema.optional(Schema.String),
  encoding: Schema.optional(Schema.String),
})

/** HAR `entry`, narrowed to the fields an import consumes. */
const HarEntryWire = Schema.Struct({
  startedDateTime: Schema.DateTimeUtc,
  request: Schema.Struct({ url: Schema.String }),
  response: Schema.Struct({
    // Looser than the sniffer's `[0, 1000]`: an odd status in someone else's
    // archive is a reason to import the entry as it stands, not to fail the file.
    status: Schema.Int,
    statusText: Schema.String,
    headers: Schema.Array(HarNameValueWire),
    content: HarContentWire,
  }),
})

/**
 * The HAR subset this package consumes.
 *
 * @remarks
 * Unknown keys are ignored — `Schema.Struct`'s default — which is what lets a
 * DevTools export's `pages`, cookies, request bodies and `_`-prefixed extras
 * ride along unread rather than fail the decode.
 */
const HarArchiveWire = Schema.Struct({
  log: Schema.Struct({
    version: Schema.String,
    entries: Schema.Array(HarEntryWire),
  }),
})

/**
 * One archived exchange, in the shape a replay consumes.
 *
 * @remarks
 * The field names are a captured response's, so an imported entry and a live
 * capture line up structurally and a replay runner needs no import of the
 * collector slice — the boundary is a shape, not a dependency, as
 * `CapturedResponse` in `src/provenance/capture-provenance.ts` is in the other
 * direction. A Chrome export's request side is dropped rather than carried: the
 * slice does not represent one.
 */
const ParsedHarEntry = Schema.Struct({
  /**
   * `har-entry-<index>` at the entry's position in `log.entries`. Synthesized
   * because HAR gives an exchange no identity of its own, and two entries can be
   * identical in every field this reads.
   */
  id: Schema.String,
  url: Schema.String,
  status: Schema.Int,
  statusText: Schema.String,
  /** Ordered pairs, repeats preserved, exactly as `HeadersWire` carries them. */
  headers: HeadersWire,
  /** `startedDateTime`, as the instant it names. */
  startedAt: Schema.DateTimeUtcFromSelf,
  /**
   * The response body as bytes — base64-decoded when the archive said `base64`,
   * UTF-8-encoded otherwise. Empty when `bodyAbsent` is set.
   */
  body: Schema.Uint8ArrayFromSelf,
  /**
   * `true` when the archive stored no body at all — a different fact from a
   * response that was empty, and the one a consumer reading `body.length` alone
   * gets wrong.
   */
  bodyAbsent: Schema.Boolean,
}).annotations({
  identifier: 'ParsedHarEntry',
  description: 'One exchange read out of a HAR archive.',
})

/** A parsed archive: the version it claimed, and its entries in file order. */
const ParsedHar = Schema.Struct({
  /**
   * `log.version` as written. Read but not enforced: the shape above is what an
   * import depends on, so a `1.1` archive carrying it is importable.
   */
  version: Schema.String,
  entries: Schema.Array(ParsedHarEntry),
}).annotations({
  identifier: 'ParsedHar',
  description: 'A HAR archive, read into the shape an import consumes.',
})

type ParsedHarEntry = typeof ParsedHarEntry.Type
type ParsedHar = typeof ParsedHar.Type

type HarContentWire = typeof HarContentWire.Type

/** What one entry's `content` says the body is. */
interface ParsedBody {
  readonly body: Uint8Array
  readonly bodyAbsent: boolean
}

const EMPTY_BODY: ParsedBody = { body: new Uint8Array(0), bodyAbsent: true }

/**
 * The bytes a `content` holds.
 *
 * @param content - The entry's `response.content`
 * @returns The bytes, or the base64 failure that stops the parse
 *
 * @remarks
 * A body claiming `base64` that is not fails rather than falling back to the
 * text verbatim — importing different bytes than the archive stated is worse
 * than refusing the file.
 */
const bodyOf = (content: HarContentWire): Either.Either<ParsedBody, string> => {
  const { text } = content
  if (text === undefined) {
    return Either.right(EMPTY_BODY)
  }
  if (content.encoding !== BASE64_ENCODING) {
    return Either.right({ body: utf8.encode(text), bodyAbsent: false })
  }
  return Either.mapBoth(Encoding.decodeBase64(text), {
    onLeft: (failure) => `content.text is not valid base64: ${failure.message}`,
    onRight: (body) => ({ body, bodyAbsent: false }),
  })
}

/**
 * A HAR archive, read into {@link ParsedHar}.
 *
 * @remarks
 * Decode-only: the parsed side drops the request, the timings, the mime types
 * and the sizes, so an encode would write an archive claiming facts nobody
 * observed. `emitHar` is the writing direction, and it starts from a
 * `TraceExchange`, which holds them.
 */
const ParsedHarFromHar = Schema.transformOrFail(HarArchiveWire, ParsedHar, {
  strict: true,
  decode: (archive, _options, ast) =>
    Either.map(
      Either.all(
        archive.log.entries.map((entry, index) =>
          Either.mapBoth(bodyOf(entry.response.content), {
            onLeft: (message) => new ParseResult.Type(ast, archive, `entry ${index}: ${message}`),
            onRight: ({ body, bodyAbsent }): ParsedHarEntry => ({
              id: `${HAR_ENTRY_ID_PREFIX}${index}`,
              url: entry.request.url,
              status: entry.response.status,
              statusText: entry.response.statusText,
              headers: entry.response.headers.map(({ name, value }) => [name, value] as const),
              startedAt: entry.startedDateTime,
              body,
              bodyAbsent,
            }),
          })
        )
      ),
      (entries): ParsedHar => ({ version: archive.log.version, entries })
    ),
  encode: (parsed, _options, ast) =>
    ParseResult.fail(
      new ParseResult.Forbidden(
        ast,
        parsed,
        'A parsed archive cannot be encoded back to HAR: the request side, timings, mime types and sizes are not carried. Emit from TraceExchange with emitHar instead.'
      )
    ),
}).annotations({
  identifier: 'ParsedHarFromHar',
  description: 'A HAR 1.2 archive read into the entries an import consumes.',
})

/** A HAR archive as its JSON text — invalid JSON fails as a `ParseError` too. */
const ParsedHarFromHarJson = Schema.parseJson(ParsedHarFromHar).annotations({
  identifier: 'ParsedHarFromHarJson',
  description: 'A HAR 1.2 archive, read from the text of a .har file.',
})

/**
 * Reads a `.har` file's text.
 *
 * @param json - The file's contents
 * @returns The parsed archive, or a `ParseError`
 *
 * @remarks
 * Invalid JSON, well-formed JSON that is not a HAR, and a HAR whose body
 * encoding is broken all fail the same way — nothing here throws.
 */
const parseHar = Schema.decodeUnknown(ParsedHarFromHarJson)

/**
 * Reads an already-parsed HAR value — one held in memory, or imported as a
 * JSON module.
 *
 * @param archive - The archive as parsed JSON
 * @returns The parsed archive, or a `ParseError`
 */
const parseHarValue = Schema.decodeUnknown(ParsedHarFromHar)

export {
  HAR_ENTRY_ID_PREFIX,
  ParsedHar,
  ParsedHarEntry,
  ParsedHarFromHar,
  ParsedHarFromHarJson,
  parseHar,
  parseHarValue,
}
