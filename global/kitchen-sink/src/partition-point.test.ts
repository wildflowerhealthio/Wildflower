import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { partitionPoint } from './index.ts'
import { numRunsFor } from './test/num-runs-for.ts'

const sortedIntegers = fc
  .array(fc.integer({ min: -50, max: 50 }))
  .map((values) => values.toSorted((a, b) => a - b))

describe('partitionPoint', () => {
  it('finds the first element at or past a target with a strict predicate', () => {
    expect(partitionPoint([1, 3, 3, 5], (n) => n < 3)).toBe(1)
  })

  it('finds the first element past a target with a non-strict predicate', () => {
    expect(partitionPoint([1, 3, 3, 5], (n) => n <= 3)).toBe(3)
  })

  it('is the length when the predicate holds for every element', () => {
    expect(partitionPoint([1, 2, 3], () => true)).toBe(3)
  })

  it('is zero for an empty array', () => {
    expect(partitionPoint([], () => true)).toBe(0)
  })

  it('property: matches a linear scan for the first element the predicate rejects', () => {
    fc.assert(
      fc.property(sortedIntegers, fc.integer({ min: -60, max: 60 }), (sorted, target) => {
        const strict = (n: number): boolean => n < target
        const nonStrict = (n: number): boolean => n <= target
        const linear = (isBefore: (n: number) => boolean): number => {
          const found = sorted.findIndex((n) => !isBefore(n))
          return found === -1 ? sorted.length : found
        }
        expect(partitionPoint(sorted, strict)).toBe(linear(strict))
        expect(partitionPoint(sorted, nonStrict)).toBe(linear(nonStrict))
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})
