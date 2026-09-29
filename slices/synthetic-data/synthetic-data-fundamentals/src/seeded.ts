import { joinIdComponents } from 'fhir-r4/identity'
import { fnv1a64, FNV_1A_64_OFFSET_BASIS } from 'kitchen-sink'

/**
 * Deterministic stand-ins for the values a real system would draw at random —
 * resource ids, prescription numbers, the minute a prescription was picked up
 * — each hashed from the names of what it belongs to.
 *
 * @remarks
 * A hash of the owning keys rather than a seeded generator stepped in order:
 * a value depends only on what it names, so adding a prescription to a story
 * leaves every other prescription's ids and times untouched. The hash is
 * `kitchen-sink`'s FNV-1a 64-bit over the keys folded with `fhir-r4`'s
 * `joinIdComponents` (length-prefixed, so `['a', 'bc']` and `['ab', 'c']` hash
 * apart whatever the keys contain), which is deterministic across runs and
 * platforms, then passed through murmur3's 64-bit finalizer ({@link fmix64})
 * so that keys differing in one character — `…-1` and `…-2` — give values that
 * differ in about half their bits, as random draws would, rather than FNV's
 * near-identical high bits.
 *
 * Nothing here decides a story. Jitter only moves a time within the day the
 * story put it on.
 */

/**
 * A second FNV-1a lane, for the upper half of a 128-bit value: the standard
 * offset basis xored with a fixed constant (the ASCII of `"wildflwr"`).
 */
const SECOND_LANE_BASIS = FNV_1A_64_OFFSET_BASIS ^ 0x77696c64666c7772n

const UINT64_MASK = 0xffff_ffff_ffff_ffffn

/**
 * murmur3's 64-bit finalizer (`fmix64`): a bijection on 64-bit values in which
 * every input bit flips each output bit with probability about one half.
 */
const fmix64 = (value: bigint): bigint => {
  let mixed = value & UINT64_MASK
  mixed ^= mixed >> 33n
  mixed = (mixed * 0xff51afd7ed558ccdn) & UINT64_MASK
  mixed ^= mixed >> 33n
  mixed = (mixed * 0xc4ceb9fe1a85ec53n) & UINT64_MASK
  mixed ^= mixed >> 33n
  return mixed
}

/** The mixed 64-bit hash of `keys`, on the lane `offsetBasis` picks. */
const hashOf = (keys: readonly string[], offsetBasis: bigint = FNV_1A_64_OFFSET_BASIS): bigint =>
  fmix64(fnv1a64(joinIdComponents(keys), offsetBasis))

/**
 * A UUID-shaped id (8-4-4-4-12 lowercase hex) derived from `keys`.
 *
 * @remarks
 * Shaped like a version-4 UUID (the version and variant nibbles are set) so it
 * reads like the GUIDs vendor APIs hand out, and it satisfies FHIR's id
 * grammar (`[A-Za-z0-9\-.]{1,64}`).
 */
const uuidOf = (keys: readonly string[]): string => {
  const hex128 =
    hashOf(keys, SECOND_LANE_BASIS).toString(16).padStart(16, '0') +
    hashOf(keys).toString(16).padStart(16, '0')
  const variantNibble = ((Number.parseInt(hex128.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
  return [
    hex128.slice(0, 8),
    hex128.slice(8, 12),
    `4${hex128.slice(13, 16)}`,
    `${variantNibble}${hex128.slice(17, 20)}`,
    hex128.slice(20, 32),
  ].join('-')
}

/**
 * An integer in `[min, max]`, both inclusive, derived from `keys`.
 *
 * @param keys - What the value belongs to
 * @param min - The smallest value returned
 * @param max - The largest value returned; must be at least `min`
 */
const integerOf = (keys: readonly string[], min: number, max: number): number =>
  min + Number(hashOf(keys) % BigInt(max - min + 1))

/**
 * A string of `length` decimal digits derived from `keys`, never starting with
 * `0` — a prescription or order number.
 *
 * @param length - At most 15: past that `10 ** length - 1` is no longer an
 *   exact `number`, so the digits drawn can fall outside `length`
 */
const digitsOf = (keys: readonly string[], length: number): string =>
  String(integerOf(keys, 10 ** (length - 1), 10 ** length - 1))

export { digitsOf, integerOf, uuidOf }
