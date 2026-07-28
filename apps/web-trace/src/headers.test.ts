import fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { keyedHeaders } from './headers.ts'

describe('keyedHeaders', () => {
  test('keeps every header, in the captured order', () => {
    const headers: readonly (readonly [string, string])[] = [
      ['Vary', 'Accept-Encoding'],
      ['Content-Type', 'application/json'],
      ['Vary', 'Accept-Encoding'],
    ]
    expect(keyedHeaders(headers).map(({ name, value }) => [name, value])).toEqual([...headers])
  })

  // The whole reason this helper exists: `name:value` collides on a response
  // that repeats a header name *and* its value, and duplicate React keys make
  // the reconciler drop or mis-associate a row.
  test('gives repeated identical headers distinct keys', () => {
    const keys = keyedHeaders([
      ['Vary', 'Accept-Encoding'],
      ['Vary', 'Accept-Encoding'],
    ]).map(({ key }) => key)
    expect(new Set(keys).size).toBe(2)
  })

  test('every key is unique, for any captured header list', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.string({ maxLength: 8 }), fc.string({ maxLength: 8 })), {
          maxLength: 24,
        }),
        (headers: readonly (readonly [string, string])[]) => {
          const keys = keyedHeaders(headers).map(({ key }) => key)
          expect(new Set(keys).size).toBe(keys.length)
        }
      )
    )
  })
})
