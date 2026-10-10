import { utf8Bytes } from './utf8.ts'

/**
 * `fhir-r4`'s `localResourceId` and `joinIdComponents` without `bigint`: the
 * deterministic id a sync's Observations are PUT under.
 *
 * @remarks
 * Internal to the package. A port rather than an import because PebbleKit JS
 * bundles it and the phone's runtime is ES5: `fhir-r4/identity` hashes with
 * `kitchen-sink`'s `fnv1a64`, whose `bigint` ES5 lacks, and `fhir-r4` brings
 * Effect. The port keeps every choice that makes the original persisted wire
 * format — the two FNV-1a 64 lanes and the second lane's displaced basis, the
 * length-prefixed components, the `wf-` prefix — so it returns the same id for
 * the same inputs, and `local-resource-id.test.ts` holds the two to that.
 *
 * A 64-bit lane is four 16-bit limbs, least significant first: a product of two
 * limbs is under 2^32 and a column of them sums well inside the 2^53 a
 * JavaScript number holds exactly.
 *
 * @packageDocumentation
 */

/** A 64-bit value as four 16-bit limbs, least significant first. */
type Limbs = ReadonlyArray<number>

const LIMB_BASE = 0x10000

/** The FNV-1a 64 offset basis, 0xcbf29ce484222325. */
const FNV_1A_64_OFFSET_BASIS: Limbs = [0x2325, 0x8422, 0x9ce4, 0xcbf2]

/** The FNV 64 prime, 2^40 + 2^8 + 0xb3. */
const FNV_64_PRIME: Limbs = [0x01b3, 0x0000, 0x0100, 0x0000]

/** `fhir-r4`'s domain separator for the second lane, 0x9e3779b97f4a7c15. */
const SECOND_LANE_DISPLACEMENT: Limbs = [0x7c15, 0x7f4a, 0x79b9, 0x9e37]

/** The prefix `fhir-r4` gives every derived id. */
const LOCAL_ID_PREFIX = 'wf'

const xorLimbs = (left: Limbs, right: Limbs): Limbs =>
  left.map((limb, index) => limb ^ right[index])

/** `left × right` modulo 2^64. */
const multiplyLimbs = (left: Limbs, right: Limbs): Limbs => {
  const columns = [0, 0, 0, 0]
  for (let i = 0; i < 4; i++) {
    for (let j = 0; i + j < 4; j++) {
      columns[i + j] += left[i] * right[j]
    }
  }
  const product: Array<number> = []
  let carry = 0
  for (const column of columns) {
    const sum = column + carry
    product.push(sum % LIMB_BASE)
    carry = Math.floor(sum / LIMB_BASE)
  }
  return product
}

/** FNV-1a 64 of `bytes`, started from `offsetBasis`. */
const fnv1a64 = (bytes: ReadonlyArray<number>, offsetBasis: Limbs): Limbs => {
  let hash = offsetBasis
  for (const byte of bytes) {
    hash = multiplyLimbs([hash[0] ^ byte, hash[1], hash[2], hash[3]], FNV_64_PRIME)
  }
  return hash
}

/** A 64-bit lane as exactly 16 lowercase hex digits. */
const hex16 = (hash: Limbs): string => {
  let hex = ''
  for (let index = 3; index >= 0; index--) {
    const limbHex = hash[index].toString(16)
    hex += '0000'.slice(limbHex.length) + limbHex
  }
  return hex
}

/**
 * Several strings folded into one unambiguously: `${length}:${value}` per
 * component, the length in UTF-16 code units, as `fhir-r4`'s
 * `joinIdComponents` folds them.
 */
const joinIdComponents = (components: ReadonlyArray<string>): string =>
  components.map((component) => `${component.length}:${component}`).join('')

/**
 * `fhir-r4`'s `localResourceId`: `wf-` and 32 lowercase hex digits, a valid
 * FHIR id whatever the inputs.
 *
 * @param system - Absolute URI naming the system the resource came from
 * @param resourceType - The FHIR resource type, e.g. `Observation`
 * @param originalId - What identifies the resource within `system`
 */
const localResourceId = (system: string, resourceType: string, originalId: string): string => {
  const bytes = utf8Bytes(joinIdComponents([system, resourceType, originalId]))
  const secondLaneBasis = xorLimbs(FNV_1A_64_OFFSET_BASIS, SECOND_LANE_DISPLACEMENT)
  return `${LOCAL_ID_PREFIX}-${hex16(fnv1a64(bytes, FNV_1A_64_OFFSET_BASIS))}${hex16(
    fnv1a64(bytes, secondLaneBasis)
  )}`
}

export { joinIdComponents, localResourceId }
