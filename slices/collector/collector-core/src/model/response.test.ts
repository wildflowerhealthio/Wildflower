import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { RemoteResponse } from './response.ts'

const encoder = new TextEncoder()

describe('RemoteResponse', () => {
  it('stores url, status, statusText, and headers', () => {
    expect(
      new RemoteResponse('https://example.com/Patient/123', 200, 'OK', {
        'content-type': 'application/json',
      })
    ).toMatchObject({
      url: 'https://example.com/Patient/123',
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
    })
  })

  it('returns empty string when no chunks appended', () => {
    expect(new RemoteResponse('https://example.com', 200, 'OK', {}).text()).toBe('')
  })

  it('returns text from a single chunk', () => {
    const response = new RemoteResponse('https://example.com', 200, 'OK', {})
    response.appendChunk(encoder.encode('hello'))
    expect(response.text()).toBe('hello')
  })

  it('concatenates multiple chunks in order', () => {
    const response = new RemoteResponse('https://example.com', 200, 'OK', {})
    response.appendChunk(encoder.encode('chunk1'))
    response.appendChunk(encoder.encode('chunk2'))
    response.appendChunk(encoder.encode('chunk3'))
    expect(response.text()).toBe('chunk1chunk2chunk3')
  })

  it('preserves any HTTP status code and statusText', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 599 }),
        fc.string({ minLength: 1 }),
        (status, statusText) => {
          expect(new RemoteResponse('https://example.com', status, statusText, {})).toMatchObject({
            status,
            statusText,
          })
        }
      )
    )
  })
})
