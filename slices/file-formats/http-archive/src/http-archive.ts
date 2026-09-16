import { Either, Encoding, ParseResult, Schema } from 'effect'

import { HeadersWire } from 'browser-sniffer-core'

import { HarMethodValueSchema, isHttpMethod } from 'http-extraction-fundamentals'
import { contentTypeOf } from 'web-trace-core/capture'
import { Har, type HarBody, type HarEntry, NOT_MEASURED } from './har.ts'

/**
 * What an import reads out of an HTTP Archive: the response half of each
 * entry, with its body as bytes.
 *
 * @remarks
 * A namespace module — consumers speak `HttpArchive.Log`, `HttpArchive.Entry`,
 * `HttpArchive.LogFromHarJson`. This is the projection of {@link Har} an
 * importer and a replay consume, and it is a schema in both directions like
 * everything else here — decoding reads an archive, encoding writes a canonical
 * one back. Encoding is *canonical*, not verbatim: what an {@link Entry} does
 * not carry (the request side, the timings, the sizes) is written as the
 * format's own "not observed" values rather than invented, so a foreign archive
 * comes back out smaller than it went in. Round-tripping the projection itself
 * is exact.
 *
 * @packageDocumentation
 */

/**
 * Prefix of an {@link Entry}'s synthesized id.
 *
 * @remarks
 * Exported so a producer that builds a {@link Log} without reading an archive —
 * the HAR recorder accumulating live responses — synthesizes the same
 * `har-entry-<index>` ids from this one definition rather than a copy of the
 * literal.
 */
const ENTRY_ID_PREFIX = 'har-entry-'

/** Why a re-encoded archive has no request side, stated in the file itself. */
const DROPPED_REQUEST_COMMENT =
  'Only the response half of this exchange was carried through the import: the URL and verb are the request, and any headers or body the source archive held were not read. They are absent rather than guessed.'

/** Why a re-encoded archive states no timings. */
const DROPPED_TIMINGS_COMMENT =
  'Timings were not carried through the import; -1 is the spec’s "not measured".'

/**
 * One entry in an HTTP Archive Log, in the shape a replay consumes.
 *
 * @remarks
 * The field names are a captured response's, so an imported entry and a live
 * capture line up structurally and a replay runner needs no import of the
 * collector slice — the boundary is a shape, not a dependency, as
 * `CapturedResponse` in `src/provenance/capture-provenance.ts` is in the other
 * direction.
 */
const Entry = Schema.Struct({
  /**
   * `har-entry-<index>` at the entry's position in `log.entries`. Synthesized
   * because the archive format gives an entry no identity of its own, and two
   * entries can be identical in every field this carries.
   */
  id: Schema.String,
  url: Schema.String,
  /**
   * The request verb, as one of the seven real HTTP methods or `'UNKNOWN'`
   * for a HAR entry whose `request.method` was dropped or unrecognized. The
   * projection normalizes anything outside the closed set to `'UNKNOWN'` at
   * the boundary rather than failing the file — a foreign archive's `'BREW'`
   * imports as an untagged verb rather than losing the entry entirely.
   */
  method: HarMethodValueSchema,
  status: Schema.Int,
  statusText: Schema.String,
  headers: HeadersWire,
  startedAt: Schema.DateTimeUtcFromSelf,
  /** The response body as bytes. Empty when {@link Entry.bodyAbsent}. */
  body: Schema.Uint8ArrayFromSelf,
  /**
   * `true` when the archive stored no body at all — a different fact from a
   * response that was empty, and the one a reader of `body.length` alone gets
   * wrong.
   */
  bodyAbsent: Schema.Boolean,
}).annotations({
  identifier: 'HttpArchiveEntry',
  description: 'One entry in an HTTP Archive Log.',
})

/** An HTTP Archive's entries, with the version its `log` claimed. */
const Log = Schema.Struct({
  version: Schema.String,
  entries: Schema.Array(Entry),
}).annotations({
  identifier: 'HttpArchiveLog',
  description: 'The entries an import reads out of an HTTP Archive.',
})

type Entry = typeof Entry.Type
type Log = typeof Log.Type

const utf8 = new TextEncoder()

/**
 * The bytes an entry's `content` holds, and whether it stored a body at all.
 *
 * @remarks
 * A base64 body that will not decode does not fail the read — it reads as an
 * absent body, the same fact `HarNoBody` carries. Firefox tags every response
 * `encoding: base64`, but for a binary body it only kept as a lossy UTF-8 string
 * it writes that mangled string under the label rather than RFC 4648 base64 (a
 * favicon comes through as its raw ICO bytes riddled with U+FFFD). Those
 * bytes are already destroyed at the source, so there is nothing to recover;
 * failing here would reject a whole archive over one unreadable favicon and lose
 * the readable entries alongside it — and a degraded body surfaces downstream as
 * a `bodyAbsent` count either way. Every other malformation — invalid JSON, JSON
 * that is not an HTTP Archive, a missing `status` — still fails the parse; only
 * an undecodable base64 body degrades.
 */
const readBody = (body: HarBody): { readonly bytes: Uint8Array; readonly absent: boolean } => {
  if (body._tag === 'HarNoBody') {
    return { bytes: new Uint8Array(0), absent: true }
  }
  if (body._tag === 'HarTextBody') {
    return { bytes: utf8.encode(body.text), absent: false }
  }
  return Either.match(Encoding.decodeBase64(body.text), {
    onLeft: () => ({ bytes: new Uint8Array(0), absent: true }),
    onRight: (bytes) => ({ bytes, absent: false }),
  })
}

const projectionOf = (entry: HarEntry, index: number): typeof Entry.Encoded => {
  const { bytes, absent } = readBody(entry.response.content.body)
  return {
    id: `${ENTRY_ID_PREFIX}${index}`,
    url: entry.request.url,
    // HAR requires `method` (defaulted to `'UNKNOWN'` in `HarRequest` when
    // absent). Anything outside the seven recognized verbs is normalized to
    // `'UNKNOWN'` at this one boundary so the projection's schema can be a
    // closed literal union without failing the file over a foreign verb.
    method: isHttpMethod(entry.request.method) ? entry.request.method : 'UNKNOWN',
    status: entry.response.status,
    statusText: entry.response.statusText,
    headers: entry.response.headers,
    startedAt: entry.startedDateTime,
    body: bytes,
    bodyAbsent: absent,
  }
}

const harEntryOf = (entry: Entry): typeof HarEntry.Type => ({
  startedDateTime: entry.startedAt,
  time: NOT_MEASURED,
  request: {
    method: entry.method,
    url: entry.url,
    httpVersion: '',
    cookies: [],
    headers: [],
    queryString: [],
    headersSize: NOT_MEASURED,
    bodySize: NOT_MEASURED,
    comment: DROPPED_REQUEST_COMMENT,
  },
  response: {
    status: entry.status,
    statusText: entry.statusText,
    httpVersion: '',
    cookies: [],
    headers: entry.headers,
    content: {
      size: entry.body.length,
      // The one content fact an entry still holds: its own headers say it.
      mimeType: contentTypeOf(entry.headers),
      body: entry.bodyAbsent
        ? { _tag: 'HarNoBody' }
        : { _tag: 'HarBase64Body', text: Encoding.encodeBase64(entry.body) },
    },
    redirectURL: '',
    headersSize: NOT_MEASURED,
    bodySize: entry.body.length,
  },
  cache: {},
  timings: {
    send: NOT_MEASURED,
    wait: NOT_MEASURED,
    receive: NOT_MEASURED,
    comment: DROPPED_TIMINGS_COMMENT,
  },
})

/**
 * An HTTP Archive, read as the entries an import replays.
 *
 * @remarks
 * Ids are positional, so a decode of an encode returns what it started with;
 * an encode of a decode returns a smaller archive, since the request side and
 * the timings are not carried. Both are stated as properties in
 * `http-archive.test.ts`.
 */
const LogFromHar = Schema.transformOrFail(Har, Log, {
  strict: true,
  // Reading an entry cannot fail — a body that will not decode degrades to
  // absent (see `readBody`) rather than failing the archive — so the decode
  // always succeeds once `Har` itself has parsed.
  decode: (archive) =>
    ParseResult.succeed({
      version: archive.log.version,
      entries: archive.log.entries.map((entry, index) => projectionOf(entry, index)),
    }),
  encode: (log) =>
    ParseResult.succeed({
      log: {
        version: log.version,
        creator: { name: 'Wildflower Web Trace', version: '0' },
        entries: log.entries.map(harEntryOf),
      },
    }),
}).annotations({
  identifier: 'HttpArchiveLogFromHar',
  description: 'The entries an import replays, carried as an HTTP Archive.',
})

/**
 * The projection, starting from the text of a `.har` file — the module's one
 * schema export.
 *
 * @remarks
 * Invalid JSON and well-formed JSON that is not an HTTP Archive fail as a
 * `ParseError`; nothing here throws. A body that claims `base64` but will not
 * decode does not fail — it reads as an absent body, because a foreign export
 * (Firefox) writes a binary body's mangled string under `encoding: base64` and
 * those bytes cannot be recovered. See `readBody`.
 */
const LogFromHarJson = Schema.parseJson(LogFromHar).annotations({
  identifier: 'HttpArchiveLogFromHarJson',
  description: 'The entries an import replays, carried as the text of a .har file.',
})

export { ENTRY_ID_PREFIX, type Entry, type Log, LogFromHarJson }
