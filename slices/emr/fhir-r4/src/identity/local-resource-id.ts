/**
 * The FNV-1a 64-bit prime, and the two offset bases the two lanes start from.
 *
 * @remarks
 * `FNV_OFFSET_A` is the standard FNV-1a 64 offset basis. `FNV_OFFSET_B` is that
 * basis xored with the 64-bit golden-ratio constant — a domain separator, so the
 * two lanes over the same bytes are independent enough for their concatenation
 * to behave as a 128-bit digest rather than as one 64-bit value written twice.
 */
const FNV_PRIME = 0x100000001b3n
const FNV_OFFSET_A = 0xcbf29ce484222325n
const FNV_OFFSET_B = FNV_OFFSET_A ^ 0x9e3779b97f4a7c15n
const MASK64 = 0xffffffffffffffffn

/** One FNV-1a 64 lane over `bytes`, started from `offsetBasis`. */
const fnv1a64 = (bytes: Uint8Array, offsetBasis: bigint): bigint => {
  let hash = offsetBasis
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = (hash * FNV_PRIME) & MASK64
  }
  return hash
}

/**
 * The prefix every derived id carries. Fixed, not per-source: source attribution
 * lives in the injected `Identifier.system`, not in the id.
 */
const LOCAL_ID_PREFIX = 'wf'

/** A 64-bit lane rendered as exactly 16 lowercase hex digits. */
const hex16 = (hash: bigint): string => hash.toString(16).padStart(16, '0')

/**
 * The deterministic local id for a resource imported from a source system.
 *
 * @param system - Absolute URI naming the source system the resource came from
 * @param resourceType - The FHIR resource type, e.g. `Patient`
 * @param originalId - The id the source used for the resource
 * @returns `wf-` followed by 32 lowercase hex digits
 *
 * @remarks
 * **This function is persisted wire format.** Its output is the primary key a
 * resource is stored under, so changing the hash — the prime, either offset
 * basis, the separator, the field order, or the prefix — orphans every resource
 * already in a store. Treat it as append-only; `local-resource-id.test.ts` pins
 * exact outputs for that reason.
 *
 * Two 64-bit FNV-1a lanes over the same bytes, concatenated, give 128 bits of
 * output from a synchronous non-cryptographic hash. Synchronous matters: entity
 * parses run through the collector's sync runner, and Web Crypto's digest is
 * async. Non-cryptographic is fine because nothing here defends against an
 * adversary choosing colliding inputs — the derivation only has to be stable and
 * collision-resistant against ordinary source ids.
 *
 * The output is always `wf-` + 32 hex, so it satisfies FHIR R4's id grammar
 * (`[A-Za-z0-9\-.]{1,64}`) whatever the inputs are — including a source id
 * carrying spaces, unicode, or a length past 64 characters.
 *
 * The three inputs are joined with `\n`. Neither an absolute URI nor a FHIR
 * resource-type token can contain a raw newline, and `originalId` comes last, so
 * the encoding is unambiguous even for a hostile id.
 */
const localResourceId = (system: string, resourceType: string, originalId: string): string => {
  const bytes = new TextEncoder().encode(`${system}\n${resourceType}\n${originalId}`)
  return `${LOCAL_ID_PREFIX}-${hex16(fnv1a64(bytes, FNV_OFFSET_A))}${hex16(fnv1a64(bytes, FNV_OFFSET_B))}`
}

export { localResourceId }
