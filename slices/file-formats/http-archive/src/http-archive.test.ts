import { DateTime, Effect, Encoding, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import type { TraceExchange } from 'web-trace-core'
import { arbitraries, jsonBody, traceExchange } from 'web-trace-core/test-helpers'
import { emitHar } from './emit.ts'
import chromeExport from './fixtures/chrome-devtools.har.json' with { type: 'json' }
import { Har } from './har.ts'
import * as HttpArchive from './http-archive.ts'

const { session: sessionArbitrary } = arbitraries(fc)

const utf8 = new TextEncoder()

const readLog = Schema.decodeUnknown(HttpArchive.LogFromHarJson)

/** Parses, asserting success — what a test about the contents wants. */
const read = (json: string): HttpArchive.Log => Effect.runSync(readLog(json))

/** Runs a parse to its `Either`, so a failure is a value rather than a throw. */
const attempt = (json: string): Either.Either<HttpArchive.Log, unknown> =>
  Effect.runSync(Effect.either(readLog(json)))

const write = (log: HttpArchive.Log): string =>
  Effect.runSync(Schema.encode(HttpArchive.LogFromHarJson)(log))

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
  test('property: an emitted archive reads back, entry for entry', () => {
    fc.assert(
      fc.property(sessionArbitrary, (session) => {
        // The emitter orders by start instant, so the expectation does too —
        // file order is what a read reports, capture order is not.
        const expected = [...session].toSorted(
          (left, right) =>
            DateTime.toEpochMillis(left.startedAt) - DateTime.toEpochMillis(right.startedAt)
        )
        const { entries } = read(emitJson(session))
        expect(entries.length).toBe(expected.length)
        for (const [index, entry] of entries.entries()) {
          const exchange = expected[index]
          expect(exchange).toBeDefined()
          if (exchange === undefined) {
            return
          }
          expect(entry.url).toBe(exchange.url)
          expect(entry.status).toBe(exchange.status)
          expect(entry.statusText).toBe(exchange.statusText)
          expect(entry.headers).toEqual(exchange.headers)
          expect(DateTime.toEpochMillis(entry.startedAt)).toBe(
            DateTime.toEpochMillis(exchange.startedAt)
          )
          expect(entry.body).toEqual(bytesOf(exchange))
          expect(entry.bodyAbsent).toBe(exchange.body._tag === 'SkippedBody')
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('ids are the entry position, the only identity the archive gives an entry', () => {
    const { entries } = read(
      emitJson([
        traceExchange({ requestId: 'req-0', startedAtMillis: Date.UTC(2024, 0, 1, 0, 0, 1) }),
        traceExchange({ requestId: 'req-1', startedAtMillis: Date.UTC(2024, 0, 1, 0, 0, 2) }),
      ])
    )
    expect(entries.map((entry) => entry.id)).toEqual(['har-entry-0', 'har-entry-1'])
  })

  test('a base64 body comes out as the bytes it encodes', () => {
    const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const { entries } = read(
      harEntry({
        content: {
          size: 8,
          mimeType: 'image/png',
          text: Encoding.encodeBase64(raw),
          encoding: 'base64',
        },
      })
    )
    expect(entries[0]?.body).toEqual(raw)
    expect(entries[0]?.bodyAbsent).toBe(false)
  })

  test('a base64 body that will not decode reads as absent, and the rest of the archive still reads', () => {
    // Firefox tags every response `encoding: base64`, but for a binary body it
    // only kept as a lossy UTF-8 string it writes that mangled string under the
    // label rather than RFC 4648 base64 — a favicon comes through as its raw ICO
    // bytes riddled with U+FFFD. Those bytes are unrecoverable, so the entry
    // reads as body-absent rather than failing the whole file; the readable
    // entries — here entry 0's valid base64 — still come through.
    const { entries } = read(
      JSON.stringify({
        log: {
          entries: [
            {
              startedDateTime: '2026-05-04T15:22:31.204Z',
              request: { url: 'https://r4.smarthealthit.org/Patient/1' },
              response: { status: 200, content: { text: 'aGk=', encoding: 'base64' } },
            },
            {
              startedDateTime: '2026-05-04T15:22:31.205Z',
              request: { url: 'https://r4.smarthealthit.org/favicon.ico' },
              // The ICO header as raw bytes with a replacement char, the way
              // Firefox writes it: NUL bytes and U+FFFD are not the base64 alphabet.
              response: {
                status: 200,
                content: { text: '\u0000\u0000\u0001\u0000\uFFFD', encoding: 'base64' },
              },
            },
          ],
        },
      })
    )
    expect(entries).toHaveLength(2)
    expect(entries[0]?.body).toEqual(utf8.encode('hi'))
    expect(entries[0]?.bodyAbsent).toBe(false)
    expect(entries[1]?.bodyAbsent).toBe(true)
    expect(entries[1]?.body).toEqual(new Uint8Array(0))
  })

  test('a plain-text body is UTF-8 encoded, multi-byte characters included', () => {
    const text = '{"name":"Ada Löveläce","note":"⚕"}'
    const { entries } = read(
      harEntry({ content: { size: text.length, mimeType: 'application/json', text } })
    )
    expect(entries[0]?.body).toEqual(utf8.encode(text))
    expect(new TextDecoder().decode(entries[0]?.body)).toBe(text)
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
    expect(stored.entries[0]?.bodyAbsent).toBe(false)

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
    expect(skipped.entries[0]?.bodyAbsent).toBe(true)
    expect(skipped.entries[0]?.body).toEqual(new Uint8Array(0))
  })

  test('repeated headers survive, in order', () => {
    const { entries } = read(
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
    expect(entries[0]?.headers).toEqual([
      ['Set-Cookie', 'session=one'],
      ['Set-Cookie', 'theme=dark'],
      ['Content-Type', 'application/json'],
    ])
  })
})

/**
 * The written file's entries, decoded rather than cast: a cast over
 * `JSON.parse` would claim the shape these assertions exist to check.
 */
const readWritten = Schema.decodeUnknownSync(
  Schema.parseJson(
    Schema.Struct({
      log: Schema.Struct({
        entries: Schema.Array(
          Schema.Struct({
            request: Schema.Struct({
              method: Schema.String,
              headers: Schema.Array(Schema.Unknown),
              comment: Schema.String,
            }),
            response: Schema.Struct({ content: Schema.Unknown }),
            timings: Schema.Struct({
              send: Schema.Number,
              wait: Schema.Number,
              receive: Schema.Number,
              comment: Schema.String,
            }),
          })
        ),
      }),
    })
  )
)

describe('writing an archive back', () => {
  const decode = Schema.decodeUnknownSync(HttpArchive.LogFromHarJson)
  const encode = Schema.encodeSync(HttpArchive.LogFromHarJson)

  test('property: decoding an encoded log returns what it started with', () => {
    fc.assert(
      fc.property(sessionArbitrary, (session) => {
        const log = read(emitJson(session))
        expect(decode(encode(log))).toEqual(log)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: a re-encoded archive still validates as a log to read', () => {
    fc.assert(
      fc.property(sessionArbitrary, (session) => {
        // Encoding is canonical, not verbatim: what survives is what an
        // `Entry` carries. Re-reading is how a caller checks that.
        const once = read(emitJson(session))
        expect(read(write(once))).toEqual(once)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('a text body is rewritten as base64, and the bytes are unchanged', () => {
    // `mimeType` is re-derived from the response's own `Content-Type`, the one
    // content fact an `Entry` still holds — without that header it would come
    // back as RFC 9110's `application/octet-stream` default.
    const once = read(
      harEntry({
        headers: [{ name: 'content-type', value: 'application/json' }],
        content: { size: 2, mimeType: 'application/json', text: 'hi' },
      })
    )
    const rewritten = readWritten(write(once))
    expect(rewritten.log.entries[0]?.response.content).toEqual({
      size: 2,
      mimeType: 'application/json',
      text: Encoding.encodeBase64(utf8.encode('hi')),
      encoding: 'base64',
    })
    expect(read(write(once)).entries[0]?.body).toEqual(utf8.encode('hi'))
  })

  test('what an import did not carry is written as the spec says "not observed", with a reason', () => {
    // Read back off the written text itself, so the assertion is about what the
    // file states rather than what a forgiving decode would default.
    const [entry] = readWritten(write(read(emitJson([traceExchange()])))).log.entries
    expect(entry?.request.method).toBe('UNKNOWN')
    expect(entry?.request.headers).toEqual([])
    expect(entry?.request.comment).toContain('not read')
    expect(entry?.timings.send).toBe(-1)
    expect(entry?.timings.wait).toBe(-1)
    expect(entry?.timings.receive).toBe(-1)
    expect(entry?.timings.comment).toContain('not carried')
  })
})

describe('a foreign archive', () => {
  const parsed = read(JSON.stringify(chromeExport))

  test('a Chrome DevTools export decodes, extra fields and all', () => {
    expect(parsed.version).toBe('1.2')
    expect(parsed.entries.map((entry) => entry.url)).toEqual([
      'https://portal.example.org/api/v2/search',
      'https://portal.example.org/assets/pixel.png',
      'https://portal.example.org/records',
    ])
  })

  test('its request side is projected to url+method only — no headers, no postData', () => {
    // The keys are the whole surface: any other request field would have to
    // show up here before anything downstream could start guessing at one.
    expect(Object.keys(parsed.entries[0] ?? {}).toSorted()).toEqual([
      'body',
      'bodyAbsent',
      'headers',
      'id',
      'method',
      'startedAt',
      'status',
      'statusText',
      'url',
    ])
  })

  test('its response fields come through, repeated set-cookie included', () => {
    expect(parsed.entries[0]?.status).toBe(200)
    // Chrome writes an empty statusText on HTTP/2, which is carried as written.
    expect(parsed.entries[0]?.statusText).toBe('')
    expect(parsed.entries[0]?.headers).toEqual([
      ['content-type', 'application/json; charset=utf-8'],
      ['set-cookie', 'session=fixture-session-token; Path=/'],
      ['set-cookie', 'theme=dark; Path=/'],
    ])
    expect(DateTime.toEpochMillis(parsed.entries[0]?.startedAt ?? DateTime.unsafeMake(0))).toBe(
      Date.parse('2026-05-04T15:22:31.204Z')
    )
  })

  test('its text body and its base64 body are both byte-correct', () => {
    expect(new TextDecoder().decode(parsed.entries[0]?.body)).toBe(
      '{"resourceType":"Bundle","type":"searchset","total":0}'
    )
    expect(parsed.entries[1]?.body).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
  })

  test('a redirect with no stored content reads as absent', () => {
    expect(parsed.entries[2]?.status).toBe(302)
    expect(parsed.entries[2]?.bodyAbsent).toBe(true)
    expect(parsed.entries[2]?.body).toEqual(new Uint8Array(0))
  })

  test('entries keep file order, which is what the synthesized ids number', () => {
    expect(parsed.entries.map((entry) => entry.id)).toEqual([
      'har-entry-0',
      'har-entry-1',
      'har-entry-2',
    ])
    // The third entry started first; a read reports what the file says rather
    // than re-sorting it.
    expect(DateTime.toEpochMillis(parsed.entries[2]?.startedAt ?? DateTime.unsafeMake(0))).toBe(
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
  ]

  for (const [name, json] of cases) {
    test(name, () => {
      expect(Either.isLeft(attempt(json))).toBe(true)
    })
  }

  test('a foreign version label is read, not enforced', () => {
    const { version, entries } = read(
      '{"log":{"version":"1.1","entries":[{"startedDateTime":"2026-05-04T15:22:31.204Z","request":{"url":"https://portal.example.org/"},"response":{"status":200,"content":{"size":0,"mimeType":"text/html"}}}]}}'
    )
    expect(version).toBe('1.1')
    expect(entries.length).toBe(1)
  })
})
