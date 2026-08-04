import { FNV_1A_64_OFFSET_BASIS, fnv1a64, utf8Bytes } from 'kitchen-sink'

/**
 * The standard FNV-1a 64 offset basis xored with the 64-bit golden-ratio
 * constant — a domain separator, so the two lanes over the same bytes
 * concatenate into 128 bits rather than one 64-bit value written twice.
 *
 * @remarks
 * The first lane uses the specified basis (`kitchen-sink`'s
 * {@link FNV_1A_64_OFFSET_BASIS}); only the second is displaced. Two lanes of
 * FNV are not a wide hash in any formal sense — see the remarks on
 * {@link localResourceId} for what this derivation is and is not claiming.
 */
const FNV_OFFSET_B = FNV_1A_64_OFFSET_BASIS ^ 0x9e3779b97f4a7c15n

/**
 * The prefix every derived id carries. Fixed, not per-source: source attribution
 * lives in the injected `Identifier.system`, not in the id.
 */
const LOCAL_ID_PREFIX = 'wf'

/** A 64-bit lane rendered as exactly 16 lowercase hex digits. */
const hex16 = (hash: bigint): string => hash.toString(16).padStart(16, '0')

/**
 * Fold several strings into one unambiguously, by length-prefixing each.
 *
 * @param components - The values to join, in a fixed order
 * @returns `${length}:${value}` per component, concatenated
 *
 * @remarks
 * **This is the encoding {@link localResourceId} hashes, so it is persisted wire
 * format too.** Why length-prefixing rather than a delimiter is argued in
 * `slices/collector/docs/Source Identity Explanation.md`; the short version is
 * that a delimiter is unambiguous only as a precondition on the caller.
 *
 * Exported so a caller folding more than one value into a single `originalId`
 * folds it the same way instead of inventing a separator. Nesting is safe — a
 * component that is itself a joined string is delimited by its own prefix.
 */
const joinIdComponents = (components: readonly string[]): string =>
  components.map((component) => `${component.length}:${component}`).join('')

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
 * basis, the component encoding, the field order, or the prefix — orphans every
 * resource already in a store. Treat it as append-only; `local-resource-id.test.ts`
 * pins exact outputs for that reason.
 *
 * The output is always `wf-` + 32 hex, so it satisfies FHIR R4's id grammar
 * whatever the inputs are — spaces, unicode, newlines, or a length past 64
 * characters included. The inputs go through {@link joinIdComponents}, so none
 * can impersonate another by carrying a separator.
 *
 * Not a cryptographic hash and not claiming to be: an adversary who controls
 * `originalId` can collide two FNV lanes. The threat this addresses is
 * accidental collision between sources, not a hostile one. That, and why this
 * rather than a digest, is argued in
 * `slices/collector/docs/Source Identity Explanation.md`.
 */
const localResourceId = (system: string, resourceType: string, originalId: string): string => {
  const bytes = utf8Bytes(joinIdComponents([system, resourceType, originalId]))
  return `${LOCAL_ID_PREFIX}-${hex16(fnv1a64(bytes))}${hex16(fnv1a64(bytes, FNV_OFFSET_B))}`
}

export { joinIdComponents, localResourceId }
