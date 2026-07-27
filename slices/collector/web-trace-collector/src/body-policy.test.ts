import { makeRemoteResponse } from 'collector-fundamentals/test-helpers'
import { Effect, Encoding } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'
import type { TraceBody } from 'web-trace-core'

import {
  type BodyPolicy,
  contentTypeOf,
  contentTypeTokens,
  decideBody,
  isAllowlisted,
  sha256Base64,
  UNKNOWN_CONTENT_TYPE,
} from './body-policy.ts'
import { DEFAULT_BODY_CONTENT_TYPES, DEFAULT_MAX_BODY_BYTES } from './config.ts'

const defaultPolicy: BodyPolicy = {
  bodyContentTypes: DEFAULT_BODY_CONTENT_TYPES,
  maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
}

const { expectRightToEqual } = utilityExpectations(expect)

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

const utf8 = new TextEncoder()

/**
 * Bytes with their backing store pinned to a real `ArrayBuffer`, which is what
 * `crypto.subtle.digest` (and so `sha256Base64`) takes. `RemoteResponse.bytes()`
 * already hands those over; `TextEncoder` and `fc.uint8Array` do not, so a test
 * that builds bytes by hand copies once here rather than making the production
 * signature looser than the platform's.
 */
const pinned = (value: string | Uint8Array): Uint8Array<ArrayBuffer> =>
  new Uint8Array(typeof value === 'string' ? utf8.encode(value) : value)

const decide = (
  overrides: Parameters<typeof makeRemoteResponse>[0],
  policy: BodyPolicy = defaultPolicy
): Promise<TraceBody> => run(decideBody(makeRemoteResponse(overrides), policy))

describe('contentTypeOf', () => {
  it.each([
    ['application/json', 'application/json'],
    ['application/json; charset=utf-8', 'application/json'],
    ['APPLICATION/FHIR+JSON; charset=UTF-8', 'application/fhir+json'],
    ['  text/html  ', 'text/html'],
  ])('reads %s as %s', (header, expected) => {
    expect(contentTypeOf([['content-type', header]])).toBe(expected)
  })

  it('matches the header name case-insensitively', () => {
    expect(contentTypeOf([['Content-Type', 'text/html']])).toBe('text/html')
  })

  it.each([
    ['no content-type header at all', [] as const],
    ['a blank content-type', [['content-type', '   ']] as const],
    ['a content-type that is only parameters', [['content-type', '; charset=utf-8']] as const],
  ])('falls back to octet-stream for %s', (_label, headers) => {
    expect(contentTypeOf(headers)).toBe(UNKNOWN_CONTENT_TYPE)
  })

  it('takes the first content-type when a malformed response carries two', () => {
    expect(
      contentTypeOf([
        ['content-type', 'text/html'],
        ['content-type', 'application/json'],
      ])
    ).toBe('text/html')
  })
})

describe('contentTypeTokens', () => {
  // The readable statement of what an allowlist entry can name. Extend it when
  // the matching rule changes.
  it.each([
    ['application/json', ['application', 'json']],
    ['text/html', ['text', 'html']],
    ['text/plain', ['text', 'plain']],
    ['application/fhir+json', ['application', 'fhir+json', 'fhir', 'json']],
    ['application/xhtml+xml', ['application', 'xhtml+xml', 'xhtml', 'xml']],
    ['image/png', ['image', 'png']],
  ])('%s answers to %j', (contentType, expected) => {
    expect([...contentTypeTokens(contentType)].toSorted()).toEqual([...expected].toSorted())
  })
})

describe('isAllowlisted', () => {
  it.each([
    // The whole reason token matching exists: the most interesting body in a
    // health-portal trace is `application/fhir+json`, and nobody adds it by
    // hand to a list they were told defaults to "json".
    'application/fhir+json',
    'application/json',
    'application/json; charset=utf-8'.split(';')[0]?.trim() ?? '',
    'text/html',
    'text/plain',
    'application/xhtml+xml',
    'text/xml',
  ])('accepts %s under the defaults', (contentType) => {
    expect(isAllowlisted(contentType, DEFAULT_BODY_CONTENT_TYPES)).toBe(true)
  })

  it.each(['image/png', 'font/woff2', 'video/mp4', 'application/octet-stream', 'application/pdf'])(
    'rejects %s under the defaults',
    (contentType) => {
      expect(isAllowlisted(contentType, DEFAULT_BODY_CONTENT_TYPES)).toBe(false)
    }
  )

  it('normalizes allowlist entries, so a stray-cased or padded entry still matches', () => {
    expect(isAllowlisted('application/json', [' JSON '])).toBe(true)
  })

  it('accepts nothing when the allowlist is empty', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (type, subtype) => {
        expect(isAllowlisted(`${type}/${subtype}`, [])).toBe(false)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('sha256Base64', () => {
  it('matches the published SHA-256 of "abc"', async () => {
    // NIST's canonical vector, so this pins the algorithm and the encoding
    // rather than restating whatever the implementation happens to produce.
    await expect(run(sha256Base64(pinned('abc')))).resolves.toBe(
      'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='
    )
  })

  it('is deterministic and collision-free across distinct bodies', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array(), fc.uint8Array(), async (a, b) => {
        const [hashA, hashA2, hashB] = await Promise.all([
          run(sha256Base64(pinned(a))),
          run(sha256Base64(pinned(a))),
          run(sha256Base64(pinned(b))),
        ])
        expect(hashA).toBe(hashA2)
        expect(hashA === hashB).toBe(a.length === b.length && a.every((x, i) => x === b[i]))
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

describe('decideBody', () => {
  it('stores an allowlisted body under the cap, base64 of the raw bytes', async () => {
    const body = '{"patient":"abc"}'
    await expect(
      decide({ headers: [['content-type', 'application/json']], body })
    ).resolves.toEqual({
      _tag: 'StoredBody',
      contentType: 'application/json',
      data: Encoding.encodeBase64(pinned(body)),
      size: body.length,
      hash: await run(sha256Base64(pinned(body))),
    })
  })

  it('stores a non-UTF-8 body byte-for-byte rather than dropping or mangling it', async () => {
    // Invariant 3: "a body that is not UTF-8 decodable is stored base64 with its
    // content type, not dropped". 0xFF is not a valid UTF-8 lead byte, so a
    // policy built on `text()` would round-trip this to U+FFFD and lose it.
    const raw = Uint8Array.from([0xff, 0xfe, 0x00, 0x41, 0x80])
    const decided = await decide({ headers: [['content-type', 'text/plain']], body: raw })

    expect(decided._tag).toBe('StoredBody')
    if (decided._tag !== 'StoredBody') return
    expectRightToEqual(Encoding.decodeBase64(decided.data), raw)
  })

  it('records a skipped body with its size and hash, and no data field', async () => {
    const raw = pinned('PNG not really')
    const decided = await decide({ headers: [['content-type', 'image/png']], body: raw })

    expect(decided).toEqual({
      _tag: 'SkippedBody',
      contentType: 'image/png',
      size: raw.length,
      hash: await run(sha256Base64(raw)),
      reason: 'content type image/png is not in the configured allowlist (json, text, html, xml)',
    })
    expect(decided).not.toHaveProperty('data')
  })

  it('skips a body over the cap, and says so', async () => {
    const decided = await decide(
      { headers: [['content-type', 'application/json']], body: '0123456789' },
      { bodyContentTypes: ['json'], maxBodyBytes: 4 }
    )

    expect(decided).toMatchObject({
      _tag: 'SkippedBody',
      contentType: 'application/json',
      size: 10,
      reason: 'body of 10 bytes exceeds the configured maxBodyBytes of 4',
    })
  })

  it('stores a body exactly at the cap — the bound is inclusive', async () => {
    await expect(
      decide(
        { headers: [['content-type', 'application/json']], body: '0123' },
        { bodyContentTypes: ['json'], maxBodyBytes: 4 }
      )
    ).resolves.toMatchObject({ _tag: 'StoredBody', size: 4 })
  })

  it('reports the allowlist as the reason when a body is both off-list and over the cap', async () => {
    await expect(
      decide(
        { headers: [['content-type', 'image/png']], body: '0123456789' },
        { bodyContentTypes: ['json'], maxBodyBytes: 4 }
      )
    ).resolves.toMatchObject({
      reason: 'content type image/png is not in the configured allowlist (json)',
    })
  })

  it('skips a body whose content type the server never stated', async () => {
    await expect(decide({ headers: [], body: 'who knows' })).resolves.toMatchObject({
      _tag: 'SkippedBody',
      contentType: UNKNOWN_CONTENT_TYPE,
    })
  })

  it('records an empty allowlisted body as stored, not skipped', async () => {
    // A 204/empty response is a real observation; skipping it would claim a
    // body was withheld when there was nothing to withhold.
    await expect(
      decide({ headers: [['content-type', 'application/json']] })
    ).resolves.toMatchObject({ _tag: 'StoredBody', size: 0, data: '' })
  })

  it('always reports the true byte size and hash, stored or skipped', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array(),
        fc.constantFrom('application/json', 'image/png', 'text/html', 'font/woff2'),
        async (raw, contentType) => {
          const decided = await decide({ headers: [['content-type', contentType]], body: raw })
          expect(decided.size).toBe(raw.length)
          expect(decided.hash).toBe(await run(sha256Base64(pinned(raw))))
          expect(decided.contentType).toBe(contentType)
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})
