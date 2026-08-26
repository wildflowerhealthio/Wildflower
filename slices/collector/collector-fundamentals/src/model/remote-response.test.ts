import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { RemoteResponse } from './remote-response.ts'

const encoder = new TextEncoder()

const STARTED_AT = DateTime.unsafeMake('2026-01-01T00:00:00.000Z')

/** A response with no body; the constructor's fixed fields aren't what most cases are about. */
const bare = (url = 'https://example.com', status = 200, statusText = 'OK'): RemoteResponse =>
  new RemoteResponse('req-1', url, status, statusText, [], STARTED_AT)

describe('RemoteResponse', () => {
  it('stores id, url, status, statusText, headers, and startedAt', () => {
    expect(
      new RemoteResponse(
        'req-42',
        'https://example.com/Patient/123',
        200,
        'OK',
        [['content-type', 'application/json']],
        STARTED_AT
      )
    ).toMatchObject({
      id: 'req-42',
      url: 'https://example.com/Patient/123',
      status: 200,
      statusText: 'OK',
      headers: [['content-type', 'application/json']],
      startedAt: STARTED_AT,
    })
  })

  it('preserves repeated headers (e.g. set-cookie) in order', () => {
    const headers = [
      ['set-cookie', 'session=abc'],
      ['set-cookie', 'remember=true'],
      ['content-type', 'text/plain'],
    ] as const
    const response = new RemoteResponse(
      'req-1',
      'https://example.com',
      200,
      'OK',
      headers,
      STARTED_AT
    )
    expect(response.headers).toEqual(headers)
  })

  it('returns empty string when no chunks appended', () => {
    expect(bare().text()).toBe('')
  })

  it('returns text from a single chunk', () => {
    const response = bare()
    response.appendChunk(encoder.encode('hello'))
    expect(response.text()).toBe('hello')
  })

  it('concatenates multiple chunks in order', () => {
    const response = bare()
    response.appendChunk(encoder.encode('chunk1'))
    response.appendChunk(encoder.encode('chunk2'))
    response.appendChunk(encoder.encode('chunk3'))
    expect(response.text()).toBe('chunk1chunk2chunk3')
  })

  it('reports zero byteLength and chunkCount with no chunks appended', () => {
    const response = bare()
    expect(response.byteLength).toBe(0)
    expect(response.chunkCount).toBe(0)
  })

  it('byteLength sums chunk lengths and chunkCount counts chunks', () => {
    fc.assert(
      fc.property(fc.array(fc.uint8Array()), (chunks) => {
        const response = bare()
        for (const chunk of chunks) response.appendChunk(chunk)
        expect(response.chunkCount).toBe(chunks.length)
        expect(response.byteLength).toBe(chunks.reduce((sum, c) => sum + c.length, 0))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('preserves any HTTP status code and statusText', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 599 }),
        fc.string({ minLength: 1 }),
        (status, statusText) => {
          expect(bare('https://example.com', status, statusText)).toMatchObject({
            status,
            statusText,
          })
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  describe('bytes()', () => {
    it('returns the concatenated chunks verbatim, for any bytes', () => {
      fc.assert(
        fc.property(fc.array(fc.uint8Array()), (chunks) => {
          const response = bare()
          for (const chunk of chunks) response.appendChunk(chunk)
          expect(response.bytes()).toEqual(
            Uint8Array.from(chunks.flatMap((chunk) => Array.from(chunk)))
          )
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })

    it('is lossless where text() is not — a non-UTF-8 body survives', () => {
      // 0xFF is not a valid UTF-8 lead byte, so `text()` yields U+FFFD and a
      // re-encode of that string is not the body that arrived. This is exactly
      // why a capturing entity has to read the body through `bytes()`.
      const invalidUtf8 = Uint8Array.from([0xff, 0xfe, 0x00, 0x41])
      const response = bare()
      response.appendChunk(invalidUtf8)

      expect(response.bytes()).toEqual(invalidUtf8)
      expect(encoder.encode(response.text())).not.toEqual(invalidUtf8)
    })

    it('hands back a fresh array, so a caller cannot mutate the buffered chunks', () => {
      const response = bare()
      response.appendChunk(encoder.encode('hello'))

      response.bytes()[0] = 0
      expect(response.text()).toBe('hello')
    })
  })
})
