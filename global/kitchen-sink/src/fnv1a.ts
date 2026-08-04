import { utf8Bytes } from './utf8-bytes.ts'

/**
 * The FNV prime for the 64-bit parameterisation: 2^40 + 2^8 + 0xb3.
 *
 * @remarks
 * Fixed by the FNV specification (Fowler / Noll / Vo, as described in the
 * `draft-eastlake-fnv` series). It is not a tuning knob — changing it produces a
 * different hash function, not a variant of this one.
 */
const FNV_64_PRIME = 0x100000001b3n

/**
 * The FNV-1a 64-bit offset basis.
 *
 * @remarks
 * The specified starting value, and therefore the hash of the empty input. Pass
 * a different basis to {@link fnv1a64} only to obtain an independent lane over
 * the same bytes (domain separation); a hash started anywhere else is no longer
 * the standard FNV-1a of its input.
 */
const FNV_1A_64_OFFSET_BASIS = 0xcbf29ce484222325n

/** 2^64 - 1; the modulus every FNV round is reduced by. */
const MASK64 = 0xffffffffffffffffn

/**
 * The 64-bit FNV-1a hash of `input`.
 *
 * @param input - The bytes to hash, or a string to hash as its UTF-8 encoding
 * @param offsetBasis - Starting value; defaults to {@link FNV_1A_64_OFFSET_BASIS}
 * @returns The hash, as a `bigint` in `[0, 2^64)`
 *
 * @remarks
 * The standard algorithm, unmodified: for each byte, xor it into the accumulator
 * and then multiply by {@link FNV_64_PRIME} modulo 2^64. The **1a** ordering
 * (xor before multiply) is the one implemented here — plain FNV-1 multiplies
 * first and produces different values. `fnv1a.test.ts` pins the published test
 * vectors, so a divergence from the specification fails there rather than
 * silently shipping a lookalike.
 *
 * **This is not a cryptographic hash.** It is fast, well-distributed for short
 * keys, and trivially invertible — reach for it for hash tables, sharding, and
 * deterministic identifiers, never for integrity, signatures, or anything an
 * adversary is incentivised to collide.
 *
 * `offsetBasis` exists so a caller wanting more than 64 bits can run several
 * independent lanes over the same bytes and concatenate them. Pick each extra
 * basis by xoring the standard one with a fixed nothing-up-my-sleeve constant;
 * running the same basis twice just yields the same value written twice.
 *
 * @example
 * ```ts
 * fnv1a64('') // 0xcbf29ce484222325n — the offset basis
 * fnv1a64('foobar') // 0x85944171f73967e8n
 * ```
 */
const fnv1a64 = (
  input: string | Uint8Array,
  offsetBasis: bigint = FNV_1A_64_OFFSET_BASIS
): bigint => {
  const bytes = typeof input === 'string' ? utf8Bytes(input) : input
  let hash = offsetBasis
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = (hash * FNV_64_PRIME) & MASK64
  }
  return hash
}

export { FNV_1A_64_OFFSET_BASIS, FNV_64_PRIME, fnv1a64 }
