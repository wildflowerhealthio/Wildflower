import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { nonEmpty } from './index.ts'
import { numRunsFor } from './test/num-runs-for.ts'

describe('nonEmpty', () => {
  it('returns a populated string unchanged', () => {
    expect(nonEmpty('Atorvastatin')).toBe('Atorvastatin')
  })

  it('treats the empty string as absent', () => {
    expect(nonEmpty('')).toBeNull()
  })

  it('treats null and undefined as absent', () => {
    expect(nonEmpty(null)).toBeNull()
    expect(nonEmpty(undefined)).toBeNull()
  })

  it('keeps a whitespace-only string — only length is checked', () => {
    expect(nonEmpty('  ')).toBe('  ')
  })

  it('property: returns the input itself or null, never a different string', () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: undefined }), (value) => {
        const result = nonEmpty(value)
        expect(result === null || result === value).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('property: a non-empty string is never reported absent', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (value) => {
        expect(nonEmpty(value)).toBe(value)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
