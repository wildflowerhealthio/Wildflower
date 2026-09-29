import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { FNV_1A_64_OFFSET_BASIS, fmix64, MASK64 } from './index.ts'
import { numRunsFor } from './test/num-runs-for.ts'

/**
 * Reference outputs of MurmurHash3's `fmix64`. Pinned so a change to a shift or
 * a constant — which would re-key everything hashed through it — fails here.
 */
const PINNED_VECTORS: readonly (readonly [bigint, bigint])[] = [
  [0n, 0n],
  [1n, 0xb456bcfc34c2cb2cn],
  [FNV_1A_64_OFFSET_BASIS, 0xefd01f60ba992926n],
  [MASK64, 0x64b5720b4b825f21n],
]

const MAX_64 = 1n << 64n

const uint64Arbitrary = fc.bigInt({ min: 0n, max: MASK64 })

/** How many of the 64 bits `left` and `right` differ in. */
const differingBits = (left: bigint, right: bigint): number =>
  (left ^ right).toString(2).replaceAll('0', '').length

describe('fmix64', () => {
  test('zero is a fixed point', () => {
    expect(fmix64(0n)).toBe(0n)
  })

  test.each(PINNED_VECTORS)('mixes %s to its pinned value', (input, expected) => {
    expect(fmix64(input)).toBe(expected)
  })

  test('property: stays inside 64 bits, reading only the low 64 of its input', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX_64 * MAX_64 }), (value) => {
        const mixed = fmix64(value)
        expect(mixed).toBeGreaterThanOrEqual(0n)
        expect(mixed).toBeLessThan(MAX_64)
        expect(mixed).toBe(fmix64(value & MASK64))
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  // The reason to mix at all: neighbouring inputs, like FNV hashes of keys that
  // differ in their last character, come out looking unrelated. About 32 bits
  // differ on average; 16 leaves a wide margin below that.
  test('property: inputs one apart differ in many output bits', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MASK64 - 1n }), (value) => {
        expect(differingBits(fmix64(value), fmix64(value + 1n))).toBeGreaterThanOrEqual(16)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  test('property: distinct inputs mix to distinct outputs', () => {
    fc.assert(
      fc.property(uint64Arbitrary, uint64Arbitrary, (left, right) => {
        fc.pre(left !== right)
        expect(fmix64(left)).not.toBe(fmix64(right))
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})
