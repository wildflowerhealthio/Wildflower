import { Either, Encoding, ParseResult, Schema } from 'effect'

import { HeadersWire } from 'browser-sniffer-core'

import { contentTypeOf } from '../capture/index.ts'
import { Har, type HarBody, type HarEntry, NOT_MEASURED } from './har.ts'

/**
 * What an import reads out of a HAR archive: the response half of each entry,
 * with its body as bytes.
 *
 * @remarks
 * This is the projection of {@link Har} an importer and a replay consume, and
 * it is a schema in both directions like everything else here — decoding reads
 * an archive, encoding writes a canonical one back. Encoding is *canonical*,
 * not verbatim: what an {@link ArchivedExchange} does not carry (the request
 * side, the timings, the sizes) is written as HAR's own "not observed" values
 * rather than invented, so a foreign archive comes back out smaller than it
 * went in. Round-tripping the projection itself is exact.
 *
 * @packageDocumentation
 */

/** Prefix of an {@link ArchivedExchange}'s synthesized id. */
const ARCHIVED_EXCHANGE_ID_PREFIX = 'har-entry-'

/** Why a re-encoded archive has no request side, stated in the file itself. */
const DROPPED_REQUEST_COMMENT =
  'Only the response half of this exchange was carried through the import: the URL is the request, and any method, headers or body the source archive held were not read. They are absent rather than guessed.'

/** Why a re-encoded archive states no timings. */
const DROPPED_TIMINGS_COMMENT =
  'Timings were not carried through the import; -1 is the spec’s "not measured".'

/**
 * One archived exchange, in the shape a replay consumes.
 *
 * @remarks
 * The field names are a captured response's, so an imported exchange and a live
 * capture line up structurally and a replay runner needs no import of the
 * collector slice — the boundary is a shape, not a dependency, as
 * `CapturedResponse` in `src/provenance/capture-provenance.ts` is in the other
 * direction.
 */
const ArchivedExchange = Schema.Struct({
  /**
   * `har-entry-<index>` at the exchange's position in `log.entries`.
   * Synthesized because HAR gives an exchange no identity of its own, and two
   * entries can be identical in every field this carries.
   */
  id: Schema.String,
  url: Schema.String,
  status: Schema.Int,
  statusText: Schema.String,
  headers: HeadersWire,
  startedAt: Schema.DateTimeUtcFromSelf,
  /** The response body as bytes. Empty when {@link ArchivedExchange.bodyAbsent}. */
  body: Schema.Uint8ArrayFromSelf,
  /**
   * `true` when the archive stored no body at all — a different fact from a
   * response that was empty, and the one a reader of `body.length` alone gets
   * wrong.
   */
  bodyAbsent: Schema.Boolean,
}).annotations({
  identifier: 'ArchivedExchange',
  description: 'One exchange read out of a HAR archive.',
})

/** An archive's exchanges, with the version its `log` claimed. */
const ArchivedSession = Schema.Struct({
  version: Schema.String,
  exchanges: Schema.Array(ArchivedExchange),
}).annotations({
  identifier: 'ArchivedSession',
  description: 'The exchanges an import reads out of a HAR archive.',
})

type ArchivedExchange = typeof ArchivedExchange.Type
type ArchivedSession = typeof ArchivedSession.Type

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
 * that is not a HAR, a missing `status` — still fails the parse; only an
 * undecodable base64 body degrades.
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

const exchangeOf = (entry: HarEntry, index: number): typeof ArchivedExchange.Encoded => {
  const { bytes, absent } = readBody(entry.response.content.body)
  return {
    id: `${ARCHIVED_EXCHANGE_ID_PREFIX}${index}`,
    url: entry.request.url,
    status: entry.response.status,
    statusText: entry.response.statusText,
    headers: entry.response.headers,
    startedAt: entry.startedDateTime,
    body: bytes,
    bodyAbsent: absent,
  }
}

const entryOf = (exchange: ArchivedExchange): typeof HarEntry.Type => ({
  startedDateTime: exchange.startedAt,
  time: NOT_MEASURED,
  request: {
    method: 'UNKNOWN',
    url: exchange.url,
    httpVersion: '',
    cookies: [],
    headers: [],
    queryString: [],
    headersSize: NOT_MEASURED,
    bodySize: NOT_MEASURED,
    comment: DROPPED_REQUEST_COMMENT,
  },
  response: {
    status: exchange.status,
    statusText: exchange.statusText,
    httpVersion: '',
    cookies: [],
    headers: exchange.headers,
    content: {
      size: exchange.body.length,
      // The one content fact an exchange still holds: its own headers say it.
      mimeType: contentTypeOf(exchange.headers),
      body: exchange.bodyAbsent
        ? { _tag: 'HarNoBody' }
        : { _tag: 'HarBase64Body', text: Encoding.encodeBase64(exchange.body) },
    },
    redirectURL: '',
    headersSize: NOT_MEASURED,
    bodySize: exchange.body.length,
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
 * A HAR archive, read as the exchanges an import replays.
 *
 * @remarks
 * Ids are positional, so a decode of an encode returns what it started with;
 * an encode of a decode returns a smaller archive, since the request side and
 * the timings are not carried. Both are stated as properties in
 * `archived-exchange.test.ts`.
 */
const ArchivedSessionFromHar = Schema.transformOrFail(Har, ArchivedSession, {
  strict: true,
  // Reading an entry cannot fail — a body that will not decode degrades to
  // absent (see `readBody`) rather than failing the archive — so the decode
  // always succeeds once `Har` itself has parsed.
  decode: (archive) =>
    ParseResult.succeed({
      version: archive.log.version,
      exchanges: archive.log.entries.map((entry, index) => exchangeOf(entry, index)),
    }),
  encode: (session) =>
    ParseResult.succeed({
      log: {
        version: session.version,
        creator: { name: 'Wildflower Web Trace', version: '0' },
        entries: session.exchanges.map(entryOf),
      },
    }),
}).annotations({
  identifier: 'ArchivedSessionFromHar',
  description: 'The exchanges an import replays, carried as a HAR 1.2 archive.',
})

/** The same, starting from the text of a `.har` file. */
const ArchivedSessionFromHarJson = Schema.parseJson(ArchivedSessionFromHar).annotations({
  identifier: 'ArchivedSessionFromHarJson',
  description: 'The exchanges an import replays, carried as the text of a .har file.',
})

/**
 * Reads a `.har` file's text.
 *
 * @remarks
 * Invalid JSON and well-formed JSON that is not a HAR fail as a `ParseError`;
 * nothing here throws. A body that claims `base64` but will not decode does not
 * fail — it reads as an absent body, because a foreign export (Firefox) writes a
 * binary body's mangled string under `encoding: base64` and those bytes cannot
 * be recovered. See `readBody`.
 */
const fromHarJson = Schema.decodeUnknown(ArchivedSessionFromHarJson)

/** Writes exchanges back out as the text of a `.har` file. */
const toHarJson = Schema.encode(ArchivedSessionFromHarJson)

export {
  ARCHIVED_EXCHANGE_ID_PREFIX,
  ArchivedExchange,
  ArchivedSession,
  ArchivedSessionFromHar,
  ArchivedSessionFromHarJson,
  DROPPED_REQUEST_COMMENT,
  DROPPED_TIMINGS_COMMENT,
  fromHarJson,
  toHarJson,
}
