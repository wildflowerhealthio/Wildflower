import fc from 'fast-check'
import { describe, it, expect } from 'vite-plus/test'
import { RemoteResponse } from './response.ts'

const encoder = new TextEncoder()

describe('RemoteResponse', () => {
  it('should store url, status, statusText, and headers', () => {
    const response = new RemoteResponse('https://example.com/Patient/123', 200, 'OK', {
      'content-type': 'application/json',
    })

    expect(response.url).toBe('https://example.com/Patient/123')
    expect(response.status).toBe(200)
    expect(response.statusText).toBe('OK')
    expect(response.headers).toEqual({ 'content-type': 'application/json' })
  })

  it('should return empty string when no chunks appended', () => {
    const response = new RemoteResponse('https://example.com', 200, 'OK', {})
    expect(response.text()).toBe('')
  })

  it('should return text from a single chunk', () => {
    const response = new RemoteResponse('https://example.com', 200, 'OK', {})
    response.appendChunk(encoder.encode('hello'))
    expect(response.text()).toBe('hello')
  })

  it('should concatenate multiple chunks in order', () => {
    const response = new RemoteResponse('https://example.com', 200, 'OK', {})
    response.appendChunk(encoder.encode('chunk1'))
    response.appendChunk(encoder.encode('chunk2'))
    response.appendChunk(encoder.encode('chunk3'))
    expect(response.text()).toBe('chunk1chunk2chunk3')
  })

  it('should preserve any HTTP status code and statusText', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 599 }),
        fc.string({ minLength: 1 }),
        (status, statusText) => {
          const response = new RemoteResponse('https://example.com', status, statusText, {})
          expect(response.status).toBe(status)
          expect(response.statusText).toBe(statusText)
        }
      )
    )
  })
})
