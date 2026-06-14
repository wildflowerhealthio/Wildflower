import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { unknownErrorToString } from './index.ts'
import { numRunsFor } from './test/num-runs-for.ts'

describe('unknownErrorToString', () => {
  it('returns the message of an Error (not the "Error: " prefix)', () => {
    expect(unknownErrorToString(new Error('boom'))).toBe('boom')
  })

  it('returns the message of an Error subclass', () => {
    expect(unknownErrorToString(new TypeError('bad type'))).toBe('bad type')
  })

  it('stringifies a thrown string', () => {
    expect(unknownErrorToString('plain string')).toBe('plain string')
  })

  it('stringifies a thrown number', () => {
    expect(unknownErrorToString(42)).toBe('42')
  })

  it('stringifies null and undefined', () => {
    expect(unknownErrorToString(null)).toBe('null')
    expect(unknownErrorToString(undefined)).toBe('undefined')
  })

  it('property: an Error always renders as its own message', () => {
    fc.assert(
      fc.property(fc.string(), (message) => {
        expect(unknownErrorToString(new Error(message))).toBe(message)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('property: a non-Error always renders as String(value)', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)), (value) => {
        expect(unknownErrorToString(value)).toBe(String(value))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
