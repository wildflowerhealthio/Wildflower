import { DateTime, Effect, Encoding, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { arbitraries, jsonBody, traceExchange } from '../test-helpers.ts'
import type { TraceExchange } from '../trace-exchange.ts'
import {
  ARCHIVED_EXCHANGE_ID_PREFIX,
  type ArchivedSession,
  ArchivedSessionFromHar,
  fromHarJson,
  toHarJson,
} from './archived-exchange.ts'
import { emitHar } from './emit.ts'
import chromeExport from './fixtures/chrome-devtools.har.json' with { type: 'json' }
import { Har } from './har.ts'

const { session: sessionArbitrary } = arbitraries(fc)

const utf8 = new TextEncoder()

/** Parses, asserting success — what a test about the contents wants. */
const read = (json: string): ArchivedSession => Effect.runSync(fromHarJson(json))

/** Runs a parse to its `Either`, so a failure is a value rather than a throw. */
const attempt = (json: string): Either.Either<ArchivedSession, unknown> =>
  Effect.runSync(Effect.either(fromHarJson(json)))

const write = (session: ArchivedSession): string => Effect.runSync(toHarJson(session))

/** An emitted archive as the text of a file, which is what an import is handed. */
const emitJson = (exchanges: readonly TraceExchange[]): string =>
  Effect.runSync(Schema.encode(Schema.parseJson(Har))(emitHar(exchanges, { sessionId: 's' })))

/** The bytes a `TraceExchange`'s body holds, which is what an import must recover. */
const bytesOf = (exchange: TraceExchange): Uint8Array =>
  exchange.body._tag === 'StoredBody'
    ? Either.getOrThrow(Encoding.decodeBase64(exchange.body.data))
    : new Uint8Array(0)

const harEntry = (response: Record<string, unknown>): string =>
  JSON.stringify({
    log: {
      version: '1.2',
      entries: [
        {
          startedDateTime: '2026-05-04T15:22:31.204Z',
          request: { url: 'https://portal.example.org/api/v2/patients' },
          response: { status: 200, statusText: 'OK', headers: [], ...response },
        },
      ],
    },
  })

describe('reading an archive', () => {
  test('property: an emitted archive reads back, exchange for exchange', () => {
    fc.assert(
      fc.property(sessionArbitrary, (session) => {
        // The emitter orders by start instant, so the expectation does too —
        // file order is what a read reports, capture order is not.
        const expected = [...session].toSorted(
          (left, right) =>
            DateTime.toEpochMillis(left.startedAt) - DateTime.toEpochMillis(right.startedAt)
        )
        const { exchanges } = read(emitJson(session))
        expect(exchanges.length).toBe(expected.length)
        for (const [index, archived] of exchanges.entries()) {
          const exchange = expected[index]
          expect(exchange).toBeDefined()
          if (exchange === undefined) {
            return
          }
          expect(archived.url).toBe(exchange.url)
          expect(archived.status).toBe(exchange.status)
          expect(archived.statusText).toBe(exchange.statusText)
          expect(archived.headers).toEqual(exchange.headers)
          expect(DateTime.toEpochMillis(archived.startedAt)).toBe(
            DateTime.toEpochMillis(exchange.startedAt)
          )
          expect(archived.body).toEqual(bytesOf(exchange))
          expect(archived.bodyAbsent).toBe(exchange.body._tag === 'SkippedBody')
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('ids are the entry position, the only identity a HAR gives an exchange', () => {
    const { exchanges } = read(
      emitJson([
        traceExchange({ requestId: 'req-0', startedAtMillis: Date.UTC(2024, 0, 1, 0, 0, 1) }),
        traceExchange({ requestId: 'req-1', startedAtMillis: Date.UTC(2024, 0, 1, 0, 0, 2) }),
      ])
    )
    expect(exchanges.map((exchange) => exchange.id)).toEqual([
      `${ARCHIVED_EXCHANGE_ID_PREFIX}0`,
      `${ARCHIVED_EXCHANGE_ID_PREFIX}1`,
    ])
  })

  test('a base64 body comes out as the bytes it encodes', () => {
    const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const { exchanges } = read(
      harEntry({
        content: {
          size: 8,
          mimeType: 'image/png',
          text: Encoding.encodeBase64(raw),
          encoding: 'base64',
        },
      })
    )
    expect(exchanges[0]?.body).toEqual(raw)
    expect(exchanges[0]?.bodyAbsent).toBe(false)
  })

  test('a plain-text body is UTF-8 encoded, multi-byte characters included', () => {
    const text = '{"name":"Ada Löveläce","note":"⚕"}'
    const { exchanges } = read(
      harEntry({ content: { size: text.length, mimeType: 'application/json', text } })
    )
    expect(exchanges[0]?.body).toEqual(utf8.encode(text))
    expect(new TextDecoder().decode(exchanges[0]?.body)).toBe(text)
  })

  test('an empty stored body is not the same fact as an unstored one', () => {
    const stored = read(
      emitJson([
        traceExchange({
          body: {
            _tag: 'StoredBody',
            contentType: 'application/json',
            data: jsonBody(''),
            size: 2,
            hash: 'h',
          },
        }),
      ])
    )
    expect(stored.exchanges[0]?.bodyAbsent).toBe(false)

    const skipped = read(
      emitJson([
        traceExchange({
          body: {
            _tag: 'SkippedBody',
            contentType: 'image/png',
            size: 918_273,
            hash: 'h',
            reason: 'Body exceeds the 2 MiB cap',
          },
        }),
      ])
    )
    expect(skipped.exchanges[0]?.bodyAbsent).toBe(true)
    expect(skipped.exchanges[0]?.body).toEqual(new Uint8Array(0))
  })

  test('repeated headers survive, in order', () => {
    const { exchanges } = read(
      emitJson([
        traceExchange({
          headers: [
            ['Set-Cookie', 'session=one'],
            ['Set-Cookie', 'theme=dark'],
            ['Content-Type', 'application/json'],
          ],
        }),
      ])
    )
    expect(exchanges[0]?.headers).toEqual([
      ['Set-Cookie', 'session=one'],
      ['Set-Cookie', 'theme=dark'],
      ['Content-Type', 'application/json'],
    ])
  })
})

/**
 * The written file's `content`, decoded rather than cast: a cast over
 * `JSON.parse` would claim the shape these assertions exist to check.
 */
const readWrittenContent = Schema.decodeUnknownSync(
  Schema.parseJson(
    Schema.Struct({
      log: Schema.Struct({
        entries: Schema.Array(
          Schema.Struct({ response: Schema.Struct({ content: Schema.Unknown }) })
        ),
      }),
    })
  )
)

describe('writing an archive back', () => {
  const decode = Schema.decodeUnknownSync(ArchivedSessionFromHar)
  const encode = Schema.encodeSync(ArchivedSessionFromHar)

  test('property: decoding an encoded session returns what it started with', () => {
    fc.assert(
      fc.property(sessionArbitrary, (session) => {
        const archived = read(emitJson(session))
        expect(decode(encode(archived))).toEqual(archived)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: a re-encoded archive still validates as a session to read', () => {
    fc.assert(
      fc.property(sessionArbitrary, (session) => {
        // Encoding is canonical, not verbatim: what survives is what an
        // `ArchivedExchange` carries. Re-reading is how a caller checks that.
        const once = read(emitJson(session))
        expect(read(write(once))).toEqual(once)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('a text body is rewritten as base64, and the bytes are unchanged', () => {
    // `mimeType` is re-derived from the response's own `Content-Type`, the one
    // content fact an `ArchivedExchange` still holds — without that header it
    // would come back as RFC 9110's `application/octet-stream` default.
    const once = read(
      harEntry({
        headers: [{ name: 'content-type', value: 'application/json' }],
        content: { size: 2, mimeType: 'application/json', text: 'hi' },
      })
    )
    const rewritten = readWrittenContent(write(once))
    expect(rewritten.log.entries[0]?.response.content).toEqual({
      size: 2,
      mimeType: 'application/json',
      text: Encoding.encodeBase64(utf8.encode('hi')),
      encoding: 'base64',
    })
    expect(read(write(once)).exchanges[0]?.body).toEqual(utf8.encode('hi'))
  })

  test('what an import did not carry is written as HAR says "not observed", with a reason', () => {
    const [entry] = encode(read(emitJson([traceExchange()]))).log.entries
    expect(entry?.request.method).toBe('UNKNOWN')
    expect(entry?.request.headers).toEqual([])
    expect(entry?.request.comment).toContain('not read')
    // `timings` is optional on the encoded side — every spec-required field an
    // import has no opinion about is — so the read is chained.
    expect(entry?.timings?.send).toBe(-1)
    expect(entry?.timings?.wait).toBe(-1)
    expect(entry?.timings?.receive).toBe(-1)
    expect(entry?.timings?.comment).toContain('not carried')
  })
})

describe('a foreign archive', () => {
  const parsed = Effect.runSync(Schema.decodeUnknown(ArchivedSessionFromHar)(chromeExport))

  test('a Chrome DevTools export decodes, extra fields and all', () => {
    expect(parsed.version).toBe('1.2')
    expect(parsed.exchanges.map((exchange) => exchange.url)).toEqual([
      'https://portal.example.org/api/v2/search',
      'https://portal.example.org/assets/pixel.png',
      'https://portal.example.org/records',
    ])
  })

  test('its request side is simply not represented — no method, no request headers, no postData', () => {
    // The keys are the whole surface: a request field would have to show up here
    // before anything downstream could start guessing at one.
    expect(Object.keys(parsed.exchanges[0] ?? {}).toSorted()).toEqual([
      'body',
      'bodyAbsent',
      'headers',
      'id',
      'startedAt',
      'status',
      'statusText',
      'url',
    ])
  })

  test('its response fields come through, repeated set-cookie included', () => {
    expect(parsed.exchanges[0]?.status).toBe(200)
    // Chrome writes an empty statusText on HTTP/2, which is carried as written.
    expect(parsed.exchanges[0]?.statusText).toBe('')
    expect(parsed.exchanges[0]?.headers).toEqual([
      ['content-type', 'application/json; charset=utf-8'],
      ['set-cookie', 'session=fixture-session-token; Path=/'],
      ['set-cookie', 'theme=dark; Path=/'],
    ])
    expect(DateTime.toEpochMillis(parsed.exchanges[0]?.startedAt ?? DateTime.unsafeMake(0))).toBe(
      Date.parse('2026-05-04T15:22:31.204Z')
    )
  })

  test('its text body and its base64 body are both byte-correct', () => {
    expect(new TextDecoder().decode(parsed.exchanges[0]?.body)).toBe(
      '{"resourceType":"Bundle","type":"searchset","total":0}'
    )
    expect(parsed.exchanges[1]?.body).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
  })

  test('a redirect with no stored content reads as absent', () => {
    expect(parsed.exchanges[2]?.status).toBe(302)
    expect(parsed.exchanges[2]?.bodyAbsent).toBe(true)
    expect(parsed.exchanges[2]?.body).toEqual(new Uint8Array(0))
  })

  test('entries keep file order, which is what the synthesized ids number', () => {
    expect(parsed.exchanges.map((exchange) => exchange.id)).toEqual([
      `${ARCHIVED_EXCHANGE_ID_PREFIX}0`,
      `${ARCHIVED_EXCHANGE_ID_PREFIX}1`,
      `${ARCHIVED_EXCHANGE_ID_PREFIX}2`,
    ])
    // The third entry started first; a read reports what the file says rather
    // than re-sorting it.
    expect(DateTime.toEpochMillis(parsed.exchanges[2]?.startedAt ?? DateTime.unsafeMake(0))).toBe(
      Date.parse('2026-05-04T15:22:31.104Z')
    )
  })
})

describe('bad input fails as a ParseError, never as a throw', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['invalid JSON', '{"log": '],
    ['JSON that is not an object', '"a string"'],
    ['JSON with no log', '{"entries":[]}'],
    ['a log with no entries', '{"log":{"version":"1.2"}}'],
    [
      'an entry with no response',
      '{"log":{"entries":[{"startedDateTime":"2026-05-04T15:22:31.204Z","request":{"url":"u"}}]}}',
    ],
    [
      'a startedDateTime that is not a date',
      harEntry({ content: {} }).replace('2026-05-04T15:22:31.204Z', 'whenever'),
    ],
    [
      'a response with no status',
      '{"log":{"entries":[{"startedDateTime":"2026-05-04T15:22:31.204Z","request":{"url":"u"},"response":{"statusText":"OK","headers":[],"content":{}}}]}}',
    ],
    [
      'a body that claims base64 and is not',
      harEntry({ content: { text: 'not base64!!', encoding: 'base64' } }),
    ],
  ]

  for (const [name, json] of cases) {
    test(name, () => {
      expect(Either.isLeft(attempt(json))).toBe(true)
    })
  }

  test('the base64 failure names the entry it came from', () => {
    const result = attempt(
      JSON.stringify({
        log: {
          entries: [0, 1].map((index) => ({
            startedDateTime: '2026-05-04T15:22:31.204Z',
            request: { url: 'u' },
            response: {
              status: 200,
              content: { text: index === 0 ? 'aGk=' : 'not base64!!', encoding: 'base64' },
            },
          })),
        },
      })
    )
    expect(Either.isLeft(result)).toBe(true)
    expect(String(Either.isLeft(result) ? result.left : '')).toContain('entry 1')
  })

  test('a foreign version label is read, not enforced', () => {
    const { version, exchanges } = read(
      '{"log":{"version":"1.1","entries":[{"startedDateTime":"2026-05-04T15:22:31.204Z","request":{"url":"https://portal.example.org/"},"response":{"status":200,"content":{"size":0,"mimeType":"text/html"}}}]}}'
    )
    expect(version).toBe('1.1')
    expect(exchanges.length).toBe(1)
  })
})
