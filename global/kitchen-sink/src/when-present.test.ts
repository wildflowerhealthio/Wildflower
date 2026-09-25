import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { whenPresent } from './index.ts'
import { numRunsFor } from './test/num-runs-for.ts'

describe('whenPresent', () => {
  it('should apply the edit to a present value', () => {
    // Act
    const doubled = whenPresent<number | null>(21, (count) => count * 2)

    // Assert
    expect(doubled).toBe(42)
  })

  it('should return an absent slot exactly as it went in, without calling the edit', () => {
    fc.assert(
      fc.property(fc.constantFrom(null, undefined), (absent) => {
        // Arrange
        const edited: unknown[] = []

        // Act
        const result = whenPresent<string | null | undefined>(absent, (value) => {
          edited.push(value)
          return value
        })

        // Assert
        expect(result).toBe(absent)
        expect(edited).toEqual([])
      }),
      { numRuns: numRunsFor({ base: 10 }) }
    )
  })

  it('should treat falsy present values as present', () => {
    fc.assert(
      fc.property(fc.constantFrom<string | number | boolean>('', 0, false), (falsy) => {
        // Act
        const result = whenPresent<string | number | boolean | null>(falsy, () => 'edited')

        // Assert — only `null` and `undefined` mean absent.
        expect(result).toBe('edited')
      }),
      { numRuns: numRunsFor({ base: 10 }) }
    )
  })
})
