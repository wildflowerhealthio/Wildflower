import { describe, expect, it } from 'vite-plus/test'

import { contentTypeOf, isOmittedContentType } from './omitted-content-types.ts'

describe('contentTypeOf', () => {
  it('extracts a bare media type', () => {
    expect(contentTypeOf([['content-type', 'application/json']])).toBe('application/json')
  })

  it('strips parameters', () => {
    expect(contentTypeOf([['content-type', 'application/json; charset=utf-8']])).toBe(
      'application/json'
    )
  })

  it('is case-insensitive on the header name', () => {
    expect(contentTypeOf([['Content-Type', 'text/html']])).toBe('text/html')
  })

  it('lower-cases the media type', () => {
    expect(contentTypeOf([['content-type', 'Application/FHIR+JSON']])).toBe('application/fhir+json')
  })

  it('returns application/octet-stream when absent', () => {
    expect(contentTypeOf([])).toBe('application/octet-stream')
  })

  it('returns application/octet-stream when blank', () => {
    expect(contentTypeOf([['content-type', '']])).toBe('application/octet-stream')
  })
})

describe('isOmittedContentType', () => {
  it.each([
    { type: 'text/javascript', expected: true },
    { type: 'application/javascript', expected: true },
    { type: 'text/css', expected: true },
    { type: 'image/png', expected: true },
    { type: 'image/svg+xml', expected: true },
    { type: 'image/webp', expected: true },
    { type: 'font/woff2', expected: true },
    { type: 'font/ttf', expected: true },
    { type: 'audio/mpeg', expected: true },
    { type: 'video/mp4', expected: true },
    { type: 'application/fhir+json', expected: false },
    { type: 'application/json', expected: false },
    { type: 'text/html', expected: false },
    { type: 'text/plain', expected: false },
    { type: 'application/xml', expected: false },
    { type: 'application/octet-stream', expected: false },
  ])('$type → $expected', ({ type, expected }) => {
    expect(isOmittedContentType([['content-type', type]])).toBe(expected)
  })

  it('returns false when content-type header is absent', () => {
    expect(isOmittedContentType([])).toBe(false)
  })

  it('handles parameters on an omitted type', () => {
    expect(isOmittedContentType([['content-type', 'text/javascript; charset=utf-8']])).toBe(true)
  })
})
