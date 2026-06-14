import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { RemoteResponse } from './response.ts'

const encoder = new TextEncoder()

describe('RemoteResponse', () => {
  it('stores url, status, statusText, and headers', () => {
    expect(
      new RemoteResponse('https://example.com/Patient/123', 200, 'OK', [
        ['content-type', 'application/json'],
      ])
    ).toMatchObject({
      url: 'https://example.com/Patient/123',
      status: 200,
      statusText: 'OK',
      headers: [['content-type', 'application/json']],
    })
  })

  it('preserves repeated headers (e.g. set-cookie) in order', () => {
    const headers = [
      ['set-cookie', 'session=abc'],
      ['set-cookie', 'remember=true'],
      ['content-type', 'text/plain'],
    ] as const
    const response = new RemoteResponse('https://example.com', 200, 'OK', headers)
    expect(response.headers).toEqual(headers)
  })

  it('returns empty string when no chunks appended', () => {
    expect(new RemoteResponse('https://example.com', 200, 'OK', []).text()).toBe('')
  })

  it('returns text from a single chunk', () => {
    const response = new RemoteResponse('https://example.com', 200, 'OK', [])
    response.appendChunk(encoder.encode('hello'))
    expect(response.text()).toBe('hello')
  })

  it('concatenates multiple chunks in order', () => {
    const response = new RemoteResponse('https://example.com', 200, 'OK', [])
    response.appendChunk(encoder.encode('chunk1'))
    response.appendChunk(encoder.encode('chunk2'))
    response.appendChunk(encoder.encode('chunk3'))
    expect(response.text()).toBe('chunk1chunk2chunk3')
  })

  it('reports zero byteLength and chunkCount with no chunks appended', () => {
    const response = new RemoteResponse('https://example.com', 200, 'OK', [])
    expect(response.byteLength).toBe(0)
    expect(response.chunkCount).toBe(0)
  })

  it('byteLength sums chunk lengths and chunkCount counts chunks', () => {
    fc.assert(
      fc.property(fc.array(fc.uint8Array()), (chunks) => {
        const response = new RemoteResponse('https://example.com', 200, 'OK', [])
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
          expect(new RemoteResponse('https://example.com', status, statusText, [])).toMatchObject({
            status,
            statusText,
          })
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
