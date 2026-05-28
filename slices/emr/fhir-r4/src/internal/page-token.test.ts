import { Encoding } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { decodePageToken, encodePageToken } from './page-token.ts'

const validPayloadArb = fc.record({
  offset: fc.integer({ min: 0, max: 1_000_000 }),
  count: fc.integer({ min: 1, max: 1000 }),
})

describe('page-token codec', () => {
  test('property: round-trip preserves payload', () => {
    fc.assert(
      fc.property(validPayloadArb, (payload) => {
        const token = encodePageToken(payload)
        const decoded = decodePageToken(token)
        expect(decoded).toEqual(payload)
      }),
      { numRuns: numRunsFor(100) }
    )
  })

  test('decodes a known token shape', () => {
    const token = encodePageToken({ offset: 10, count: 25 })
    expect(decodePageToken(token)).toEqual({ offset: 10, count: 25 })
  })

  test('property: corrupt base64 yields undefined', () => {
    const notBase64 = fc.string({ minLength: 1 }).filter((s) => /[^A-Za-z0-9_-]/.test(s))
    fc.assert(
      fc.property(notBase64, (token) => {
        expect(decodePageToken(token)).toBeUndefined()
      }),
      { numRuns: numRunsFor(100) }
    )
  })

  test('property: base64url of non-JSON yields undefined', () => {
    const nonJsonString = fc.string({ minLength: 1 }).filter((s) => {
      try {
        JSON.parse(s)
        return false
      } catch {
        return true
      }
    })
    fc.assert(
      fc.property(nonJsonString, (raw) => {
        const token = Encoding.encodeBase64Url(raw)
        expect(decodePageToken(token)).toBeUndefined()
      }),
      { numRuns: numRunsFor(100) }
    )
  })

  test.each([
    { offset: -1, count: 10 },
    { offset: 0, count: 0 },
    { offset: 0, count: 1001 },
    { offset: 0.5, count: 10 },
  ])('out-of-range payload $offset/$count yields undefined', (payload) => {
    const token = Encoding.encodeBase64Url(JSON.stringify(payload))
    expect(decodePageToken(token)).toBeUndefined()
  })

  test('non-object JSON payloads yield undefined', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant('null'),
          fc.constant('42'),
          fc.constant('"string"'),
          fc.constant('[1, 2, 3]')
        ),
        (jsonText) => {
          const token = Encoding.encodeBase64Url(jsonText)
          expect(decodePageToken(token)).toBeUndefined()
        }
      ),
      { numRuns: numRunsFor(100) }
    )
  })
})
