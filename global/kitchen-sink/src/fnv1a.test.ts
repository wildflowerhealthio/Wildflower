import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { FNV_1A_64_OFFSET_BASIS, FNV_64_PRIME, fnv1a64, utf8Bytes } from './index.ts'
import { numRunsFor } from './test/num-runs-for.ts'

/**
 * The published FNV-1a 64 test vectors, from the reference `test_fnv.c`
 * distributed with Fowler / Noll / Vo's own implementation.
 *
 * These are what make "it's the standard implementation" a checked fact rather
 * than a claim about the shape of the code. A hash that xors *after* the
 * multiply (that is FNV-1, not FNV-1a), that uses a different prime or basis, or
 * that reduces at the wrong width fails here.
 */
const PUBLISHED_VECTORS: readonly (readonly [string, bigint])[] = [
  ['', 0xcbf29ce484222325n],
  ['a', 0xaf63dc4c8601ec8cn],
  ['b', 0xaf63df4c8601f1a5n],
  ['c', 0xaf63de4c8601eff2n],
  ['d', 0xaf63d94c8601e773n],
  ['e', 0xaf63d84c8601e5c0n],
  ['f', 0xaf63db4c8601ead9n],
  ['fo', 0x08985907b541d342n],
  ['foo', 0xdcb27518fed9d577n],
  ['foob', 0xdd120e790c2512afn],
  ['fooba', 0xcac165afa2fef40an],
  ['foobar', 0x85944171f73967e8n],
]

const MAX_64 = 1n << 64n

describe('fnv1a64', () => {
  test.each(PUBLISHED_VECTORS)('matches the published vector for %j', (input, expected) => {
    expect(fnv1a64(input)).toBe(expected)
  })

  test('the specified constants are the ones the algorithm is defined with', () => {
    expect(FNV_64_PRIME).toBe(2n ** 40n + 2n ** 8n + 0xb3n)
    // The offset basis is by construction the hash of the empty input.
    expect(fnv1a64('')).toBe(FNV_1A_64_OFFSET_BASIS)
  })

  test('a string hashes as its UTF-8 bytes', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), (text) => {
        expect(fnv1a64(text)).toBe(fnv1a64(utf8Bytes(text)))
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  test('stays inside 64 bits', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        const hash = fnv1a64(bytes)
        expect(hash).toBeGreaterThanOrEqual(0n)
        expect(hash).toBeLessThan(MAX_64)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  test('is deterministic', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (bytes) => {
        expect(fnv1a64(bytes)).toBe(fnv1a64(bytes))
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  // The reason `offsetBasis` is exposed at all: two lanes over the same bytes
  // are only worth concatenating if they disagree.
  test('a different offset basis gives an independent lane', () => {
    const other = FNV_1A_64_OFFSET_BASIS ^ 0x9e3779b97f4a7c15n
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (bytes) => {
        expect(fnv1a64(bytes, other)).not.toBe(fnv1a64(bytes))
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  // Not a property of FNV in general — it is a property of *this* byte-at-a-time
  // formulation, and it is what lets a caller hash a buffer it already has
  // without copying.
  test('an empty input is the basis, and appending one byte advances one round', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 255 }), (byte) => {
        expect(fnv1a64(Uint8Array.of(byte))).toBe(
          ((FNV_1A_64_OFFSET_BASIS ^ BigInt(byte)) * FNV_64_PRIME) & 0xffffffffffffffffn
        )
      }),
      // Every byte value, exhaustively: `minimum` matches `base` so risk
      // scaling cannot shrink the sweep below full coverage of the domain.
      { numRuns: numRunsFor({ base: 256, minimum: 256 }) }
    )
  })
})
