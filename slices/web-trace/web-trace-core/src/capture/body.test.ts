import { Effect, Encoding } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { contentTypeOf, sha256Base64, storeBodyVerbatim, UNKNOWN_CONTENT_TYPE } from './body.ts'

const bytes = (values: readonly number[]): Uint8Array<ArrayBuffer> => Uint8Array.from(values)

describe('contentTypeOf', () => {
  it.each([
    { headers: [['content-type', 'application/json']], expected: 'application/json' },
    // Header names are not case-fixed by HTTP and the sniffer forwards what arrived.
    { headers: [['Content-Type', 'APPLICATION/JSON']], expected: 'application/json' },
    // Parameters are dropped; the media type keeps its structured suffix.
    {
      headers: [['content-type', 'application/fhir+json; charset=utf-8']],
      expected: 'application/fhir+json',
    },
    { headers: [], expected: UNKNOWN_CONTENT_TYPE },
    { headers: [['content-type', '']], expected: UNKNOWN_CONTENT_TYPE },
    { headers: [['content-type', '   ']], expected: UNKNOWN_CONTENT_TYPE },
    // A response carrying two is malformed; the record states the one a parser
    // would have used.
    {
      headers: [
        ['content-type', 'text/html'],
        ['content-type', 'application/json'],
      ],
      expected: 'text/html',
    },
  ])('should read $expected', ({ headers, expected }) => {
    expect(contentTypeOf(headers.map(([name, value]) => [name ?? '', value ?? ''] as const))).toBe(
      expected
    )
  })
})

describe('sha256Base64', () => {
  // The NIST vector for "abc", so the digest is pinned to a published value
  // rather than to whatever this implementation happens to produce.
  it('should match the published SHA-256 of "abc"', async () => {
    await expect(
      Effect.runPromise(sha256Base64(new TextEncoder().encode('abc')))
    ).resolves.toBe('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=')
  })
})

describe('storeBodyVerbatim', () => {
  it('should store the body as base64 of the raw bytes', async () => {
    const body = bytes([0, 1, 2, 250, 251])
    const stored = await Effect.runPromise(
      storeBodyVerbatim(body, [['content-type', 'application/octet-stream']])
    )
    expect(stored).toMatchObject({
      _tag: 'StoredBody',
      contentType: 'application/octet-stream',
      data: Encoding.encodeBase64(body),
      size: 5,
    })
  })

  // No allowlist and no cap is the whole difference from the recorder's policy:
  // a body that justifies a clinical resource *is* the provenance, so storing
  // size and hash with no data would defeat the point.
  it('should store a body no recorder allowlist would carry, at a size no cap would allow', async () => {
    const big = new Uint8Array(4 * 1024 * 1024)
    const stored = await Effect.runPromise(
      storeBodyVerbatim(big, [['content-type', 'video/mp4']])
    )
    expect(stored._tag).toBe('StoredBody')
    expect(stored.size).toBe(4 * 1024 * 1024)
    expect(stored.contentType).toBe('video/mp4')
  })

  it('should always report the true size and a digest of what it stored', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 512 }), async (drawn: Uint8Array) => {
        const body = bytes([...drawn])
        const stored = await Effect.runPromise(storeBodyVerbatim(body, []))
        expect(stored.size).toBe(body.length)
        expect(stored.hash).toBe(await Effect.runPromise(sha256Base64(body)))
        // Round-trips: what was stored decodes back to exactly what arrived.
        expect([...Encoding.decodeBase64(stored.data).pipe((either) =>
          either._tag === 'Right' ? either.right : new Uint8Array()
        )]).toEqual([...body])
      }),
      { numRuns: numRunsFor('slices/web-trace/web-trace-core') }
    )
  })
})
