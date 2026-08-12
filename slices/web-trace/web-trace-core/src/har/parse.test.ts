import { DateTime, Effect, Encoding, Either } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { arbitraries, jsonBody, traceExchange } from '../test-helpers.ts'
import type { TraceExchange } from '../trace-exchange.ts'
import { emitHar } from './emit.ts'
import chromeExport from './fixtures/chrome-devtools.har.json' with { type: 'json' }
import { HAR_ENTRY_ID_PREFIX, type ParsedHar, parseHar, parseHarValue } from './parse.ts'

const { session: sessionArbitrary } = arbitraries(fc)

const utf8 = new TextEncoder()

/** Runs a parse to its `Either`, so a failure is a value rather than a throw. */
const attempt = (json: string): Either.Either<ParsedHar, unknown> =>
  Effect.runSync(Effect.either(parseHar(json)))

/** Parses, asserting success — what a test about the contents wants. */
const parse = (json: string): ParsedHar => Effect.runSync(parseHar(json))

const emitJson = (exchanges: readonly TraceExchange[]): string =>
  JSON.stringify(emitHar(exchanges, { sessionId: 'session-2f8c', creatorVersion: '1.0.0' }))

/** The bytes a `TraceExchange`'s body holds, which is what a parse must recover. */
const bytesOf = (exchange: TraceExchange): Uint8Array =>
  exchange.body._tag === 'StoredBody'
    ? Either.getOrThrow(Encoding.decodeBase64(exchange.body.data))
    : new Uint8Array(0)

describe('parseHar', () => {
  test('property: an emitted archive round-trips, entry for entry', () => {
    fc.assert(
      fc.property(sessionArbitrary, (session) => {
        // The emitter orders by start instant, so the expectation does too —
        // file order is the parser's contract, capture order is not.
        const expected = [...session].toSorted(
          (left, right) =>
            DateTime.toEpochMillis(left.startedAt) - DateTime.toEpochMillis(right.startedAt)
        )
        const { entries } = parse(emitJson(session))
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

  test('ids are the entry position, so a caller has a key the format itself does not give', () => {
    const { entries } = parse(
      emitJson([
        traceExchange({ requestId: 'req-0', startedAtMillis: Date.UTC(2024, 0, 1, 0, 0, 1) }),
        traceExchange({ requestId: 'req-1', startedAtMillis: Date.UTC(2024, 0, 1, 0, 0, 2) }),
      ])
    )
    expect(entries.map((entry) => entry.id)).toEqual([
      `${HAR_ENTRY_ID_PREFIX}0`,
      `${HAR_ENTRY_ID_PREFIX}1`,
    ])
  })

  test('a base64 body comes out as the bytes it encodes', () => {
    const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const { entries } = parse(
      emitJson([
        traceExchange({
          body: {
            _tag: 'StoredBody',
            contentType: 'image/png',
            data: Encoding.encodeBase64(raw),
            size: raw.length,
            hash: 'h',
          },
        }),
      ])
    )
    expect(entries[0]?.body).toEqual(raw)
    expect(entries[0]?.bodyAbsent).toBe(false)
  })

  test('a plain-text body is UTF-8 encoded, multi-byte characters included', () => {
    const text = '{"name":"Ada Löveläce","note":"⚕"}'
    const { entries } = parse(
      JSON.stringify({
        log: {
          version: '1.2',
          entries: [
            {
              startedDateTime: '2026-05-04T15:22:31.204Z',
              request: { url: 'https://portal.example.org/api/v2/patients' },
              response: {
                status: 200,
                statusText: 'OK',
                headers: [],
                content: { size: text.length, mimeType: 'application/json', text },
              },
            },
          ],
        },
      })
    )
    expect(entries[0]?.body).toEqual(utf8.encode(text))
    expect(new TextDecoder().decode(entries[0]?.body)).toBe(text)
  })

  test('an empty stored body is not the same fact as an unstored one', () => {
    const { entries } = parse(
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
    expect(entries[0]?.bodyAbsent).toBe(false)
  })

  test("a skipped body — our own emitter's size-with-no-text — parses as absent, not empty", () => {
    const { entries } = parse(
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
    expect(entries[0]?.bodyAbsent).toBe(true)
    expect(entries[0]?.body).toEqual(new Uint8Array(0))
  })

  test('repeated headers survive, in order', () => {
    const { entries } = parse(
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

describe('a foreign archive', () => {
  const parsed = Effect.runSync(parseHarValue(chromeExport))

  test('a Chrome DevTools export decodes, extra fields and all', () => {
    expect(parsed.version).toBe('1.2')
    expect(parsed.entries.map((entry) => entry.url)).toEqual([
      'https://portal.example.org/api/v2/search',
      'https://portal.example.org/assets/pixel.png',
      'https://portal.example.org/records',
    ])
  })

  test('its request side is simply not represented — no method, no request headers, no postData', () => {
    // The keys are the whole surface: a request field would have to show up here
    // before anything downstream could start guessing at one.
    expect(Object.keys(parsed.entries[0] ?? {}).toSorted()).toEqual([
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
      `${HAR_ENTRY_ID_PREFIX}0`,
      `${HAR_ENTRY_ID_PREFIX}1`,
      `${HAR_ENTRY_ID_PREFIX}2`,
    ])
    // The third entry started first; a parse reports what the file says rather
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
      '{"log":{"version":"1.2","entries":[{"startedDateTime":"2026-05-04T15:22:31.204Z","request":{"url":"https://portal.example.org/"}}]}}',
    ],
    [
      'a startedDateTime that is not a date',
      '{"log":{"version":"1.2","entries":[{"startedDateTime":"whenever","request":{"url":"u"},"response":{"status":200,"statusText":"OK","headers":[],"content":{}}}]}}',
    ],
    [
      'a body that claims base64 and is not',
      '{"log":{"version":"1.2","entries":[{"startedDateTime":"2026-05-04T15:22:31.204Z","request":{"url":"u"},"response":{"status":200,"statusText":"OK","headers":[],"content":{"text":"not base64!!","encoding":"base64"}}}]}}',
    ],
  ]

  for (const [name, json] of cases) {
    test(name, () => {
      const result = attempt(json)
      expect(Either.isLeft(result)).toBe(true)
    })
  }

  test('the base64 failure names the entry it came from', () => {
    const result = attempt(
      `{"log":{"version":"1.2","entries":[${[0, 1]
        .map(
          (index) =>
            `{"startedDateTime":"2026-05-04T15:22:31.20${index}Z","request":{"url":"u"},"response":{"status":200,"statusText":"OK","headers":[],"content":{"text":"${
              index === 0 ? 'aGk=' : 'not base64!!'
            }","encoding":"base64"}}}`
        )
        .join(',')}]}}`
    )
    expect(Either.isLeft(result)).toBe(true)
    expect(String(Either.isLeft(result) ? result.left : '')).toContain('entry 1')
  })

  test('a foreign version label is read, not enforced', () => {
    const { version, entries } = parse(
      '{"log":{"version":"1.1","entries":[{"startedDateTime":"2026-05-04T15:22:31.204Z","request":{"url":"https://portal.example.org/"},"response":{"status":200,"statusText":"OK","headers":[],"content":{"size":0,"mimeType":"text/html"}}}]}}'
    )
    expect(version).toBe('1.1')
    expect(entries.length).toBe(1)
  })
})
