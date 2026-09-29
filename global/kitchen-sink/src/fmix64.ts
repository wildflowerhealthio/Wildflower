import { MASK64 } from './fnv1a.ts'

/**
 * murmur3's 64-bit finalizer (`fmix64`): mixes a 64-bit value so that every
 * input bit affects every output bit.
 *
 * @param value - The value to mix; only its low 64 bits are read
 * @returns The mixed value, as a `bigint` in `[0, 2^64)`
 *
 * @remarks
 * Austin Appleby's finalizer from MurmurHash3, unmodified: three xor-shifts by
 * 33 around two multiplies by fixed odd constants, each reduced by
 * {@link MASK64}. Each step is invertible, so the whole is a **bijection** on
 * 64-bit values — it never merges two inputs — and it **avalanches**: flipping
 * any one input bit flips each output bit with probability about one half.
 *
 * Its use here is spreading {@link fnv1a64} outputs. FNV-1a over inputs that
 * differ only in their last byte (`…-1`, `…-2`) gives values that differ mostly
 * in their low bits; passed through this, they differ in about half of all 64,
 * as independent draws would. `fmix64.test.ts` pins reference outputs.
 *
 * **This is not a cryptographic function.** It is a fixed, public, invertible
 * permutation: it hides nothing from anyone who wants to undo it.
 *
 * @example
 * ```ts
 * fmix64(0n) // 0n — zero is a fixed point
 * fmix64(1n) // 0xb456bcfc34c2cb2cn
 * ```
 */
const fmix64 = (value: bigint): bigint => {
  let mixed = value & MASK64
  mixed ^= mixed >> 33n
  mixed = (mixed * 0xff51afd7ed558ccdn) & MASK64
  mixed ^= mixed >> 33n
  mixed = (mixed * 0xc4ceb9fe1a85ec53n) & MASK64
  mixed ^= mixed >> 33n
  return mixed
}

export { fmix64 }
