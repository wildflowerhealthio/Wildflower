import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Seeded from './seeded.ts'

const RUNS = numRunsFor({ base: 200 })

const keysArbitrary = fc.array(fc.string(), { minLength: 1, maxLength: 4 })

describe('Seeded.uuidOf', () => {
  test('property: is a version-4-shaped UUID, and a valid FHIR id', () => {
    fc.assert(
      fc.property(keysArbitrary, (keys) => {
        const uuid = Seeded.uuidOf(keys)
        expect(uuid).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        )
        expect(uuid).toMatch(/^[A-Za-z0-9\-.]{1,64}$/)
      }),
      { numRuns: RUNS }
    )
  })

  test('property: depends on how the keys are split, not only their concatenation', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (left, right) => {
        expect(Seeded.uuidOf([left, right])).not.toBe(Seeded.uuidOf([left + right]))
      }),
      { numRuns: RUNS }
    )
  })

  test('is stable across runs', () => {
    // Pinned so a change to the derivation, which would re-key every
    // published resource, fails here rather than passing unnoticed.
    expect(Seeded.uuidOf(['rexall', 'warren'])).toBe('23f445f7-3f03-42dd-be1f-5e5fc63c1a9f')
  })
})

describe('Seeded.integerOf', () => {
  test('property: stays within its bounds and repeats for the same keys', () => {
    fc.assert(
      fc.property(
        keysArbitrary,
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: 0, max: 100_000 }),
        (keys, min, span) => {
          const value = Seeded.integerOf(keys, min, min + span)
          expect(value).toBeGreaterThanOrEqual(min)
          expect(value).toBeLessThanOrEqual(min + span)
          expect(Seeded.integerOf(keys, min, min + span)).toBe(value)
        }
      ),
      { numRuns: RUNS }
    )
  })
})

describe('Seeded.digitsOf', () => {
  test('property: is exactly `length` digits with no leading zero', () => {
    fc.assert(
      fc.property(keysArbitrary, fc.integer({ min: 1, max: 15 }), (keys, length) => {
        expect(Seeded.digitsOf(keys, length)).toMatch(new RegExp(`^[1-9][0-9]{${length - 1}}$`))
      }),
      { numRuns: RUNS }
    )
  })
})
