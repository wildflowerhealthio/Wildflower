import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Seeding from './seeding.ts'

const RUNS = numRunsFor({ base: 200 })

const keysArbitrary = fc.array(fc.string(), { minLength: 1, maxLength: 4 })

describe('Seeding.uuidOf', () => {
  test('property: is a version-4-shaped UUID, and a valid FHIR id', () => {
    fc.assert(
      fc.property(keysArbitrary, (keys) => {
        const uuid = Seeding.uuidOf(keys)
        expect(uuid).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        )
        expect(uuid).toMatch(/^[A-Za-z0-9\-.]{1,64}$/)
      }),
      { numRuns: RUNS }
    )
  })

  test('property: depends on how the keys are split, not only their concatenation', () => {
    const keyArbitrary = fc.string({ unit: 'binary', minLength: 1 })
    fc.assert(
      fc.property(keyArbitrary, keyArbitrary, (left, right) => {
        expect(Seeding.uuidOf([left, right])).not.toBe(Seeding.uuidOf([left + right]))
      }),
      { numRuns: RUNS }
    )
  })

  test('tells a key holding a control character from two keys', () => {
    expect(Seeding.uuidOf(['a\u001fb'])).not.toBe(Seeding.uuidOf(['a', 'b']))
  })

  test('property: gives sibling keys uuids that differ in most hex positions', () => {
    fc.assert(
      fc.property(fc.string(), fc.nat({ max: 999 }), fc.nat({ max: 999 }), (stem, left, right) => {
        fc.pre(left !== right)
        const leftHex = Seeding.uuidOf(['rx', `${stem}-${left}`]).replaceAll('-', '')
        const rightHex = Seeding.uuidOf(['rx', `${stem}-${right}`]).replaceAll('-', '')
        const differing = leftHex
          .split('')
          .filter((digit, index) => digit !== rightHex[index]).length
        // 30 free nibbles differ with probability 15/16 each: about 28 expected.
        expect(differing).toBeGreaterThanOrEqual(20)
      }),
      { numRuns: RUNS }
    )
  })

  test('is stable across runs', () => {
    // Pinned so a change to the derivation, which would re-key every
    // published resource, fails here rather than passing unnoticed.
    expect(Seeding.uuidOf(['source', 'person-1'])).toBe('bc6d963f-8bf0-4363-997b-dbae8bbfe22b')
  })
})

describe('Seeding.integerOf', () => {
  test('property: stays within its bounds and repeats for the same keys', () => {
    fc.assert(
      fc.property(
        keysArbitrary,
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: 0, max: 100_000 }),
        (keys, min, span) => {
          const value = Seeding.integerOf(keys, min, min + span)
          expect(value).toBeGreaterThanOrEqual(min)
          expect(value).toBeLessThanOrEqual(min + span)
          expect(Seeding.integerOf(keys, min, min + span)).toBe(value)
        }
      ),
      { numRuns: RUNS }
    )
  })
})

describe('Seeding.digitsOf', () => {
  test('property: is exactly `length` digits with no leading zero', () => {
    fc.assert(
      fc.property(keysArbitrary, fc.integer({ min: 1, max: 15 }), (keys, length) => {
        expect(Seeding.digitsOf(keys, length)).toMatch(new RegExp(`^[1-9][0-9]{${length - 1}}$`))
      }),
      { numRuns: RUNS }
    )
  })
})
