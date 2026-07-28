import type { IdentifierType } from '../data-types/complex/identifier-and-reference.ts'

/**
 * Finding and rewriting the relative `Type/id` references inside a decoded
 * resource, so re-keying a resource does not strand the links pointing at it.
 *
 * @packageDocumentation
 *
 * @remarks
 * Re-keying is not a per-resource operation, even though it looks like one. A
 * `MedicationRequest` says `subject: { reference: 'Patient/uid-abc' }`; the
 * moment that `Patient` is stored under a derived id, the reference names a
 * resource the store does not have. The two have to move together.
 *
 * The walk is deliberately field-agnostic rather than a list of known reference
 * slots: there are ~35 `Reference` fields across the six resources this slice
 * models, several nested in backbone elements
 * (`MedicationDispense.performer[].actor`), and the set grows with every schema
 * change — an enumeration would be stale on arrival and fail _silently_,
 * leaving exactly the dangling references it was written to prevent.
 */

/** A reference of the bare relative form `Type/id`, split into its two parts. */
interface RelativeReference {
  readonly resourceType: string
  readonly id: string
}

/**
 * What a rewrite substitutes for one relative reference.
 *
 * @remarks
 * The `identifier` rides along for the same reason a re-keyed resource keeps
 * one: derivation is one-way, so a rewritten reference would otherwise lose all
 * trace of the `Patient/uid-abc` the source wrote. FHIR allows a reference to
 * carry both a literal `reference` and a logical `identifier`, so nothing is
 * dropped to record it.
 */
interface RewrittenReference {
  readonly reference: string
  readonly identifier: IdentifierType
}

/**
 * Decides what one relative reference becomes; `null` leaves it as it stands.
 */
type ReferenceRewrite = (reference: RelativeReference) => RewrittenReference | null

/**
 * The bare relative form, and only it: a capitalized resource type, one slash,
 * and an id.
 *
 * @remarks
 * Three other reference forms are matched *out* by construction, each because
 * rewriting it would be wrong rather than merely unhandled:
 *
 * - `#contained` — points inside the resource itself, so it survives re-keying
 *   untouched and rewriting it would break a link that was never broken.
 * - `http://other.example/fhir/Patient/1` and `urn:uuid:…` — absolute, and
 *   therefore already unambiguous without the store's namespace. Both are
 *   excluded by the leading capital, which a scheme never has.
 * - `Patient/1/_history/2` — version-specific, and the store keeps no version
 *   history, so no derived id resolves it either way. Excluded by the id
 *   admitting no second slash, which also leaves a source id that _contains_ a
 *   slash alone: the relative form cannot name one unambiguously for anybody.
 *
 * The id part is deliberately **not** held to FHIR's `[A-Za-z0-9-.]{1,64}`.
 * A source assigning ids FHIR would reject is the normal case here — it is why
 * ids are derived at all — and such a resource is re-keyed regardless, so
 * holding _references_ to the stricter rule would rewrite the resource and
 * leave every pointer to it behind. A property test in
 * `adopt-source-identity.test.ts` caught exactly that.
 */
const RELATIVE_REFERENCE_PATTERN = /^([A-Z][A-Za-z]*)\/([^/]+)$/

/**
 * Split a reference string into `Type` and `id`, when it is a bare relative one.
 *
 * @param reference - The `Reference.reference` value as it was decoded
 * @returns Its two parts, or `null` for any other reference form
 */
const parseRelativeReference = (reference: string): RelativeReference | null => {
  const match = RELATIVE_REFERENCE_PATTERN.exec(reference)
  const resourceType = match?.[1]
  const id = match?.[2]
  return resourceType === undefined || id === undefined ? null : { resourceType, id }
}

/**
 * Whether a value is a plain object — one this module may take apart and
 * rebuild.
 *
 * @param value - Any decoded value
 * @returns `true` only for object literals (and null-prototype objects)
 *
 * @remarks
 * **Load-bearing, not defensive.** A decoded FHIR value holds class instances —
 * `Identifier.system` and `Resource.implicitRules` are `URL`s — whose state
 * lives behind prototype accessors, so `Object.entries` reports _no_
 * properties and a rebuild from its entries hands back an empty object literal,
 * quietly erasing the field. Only plain records are rebuilt; everything else is
 * passed through by reference.
 */
const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Apply a rewrite to one already-rebuilt record, if it is a `Reference`.
 *
 * @param record - A rebuilt plain record
 * @param rewrite - The rewrite to consult
 * @returns The record with `reference` (and possibly `identifier`) replaced, or
 *   the record unchanged
 *
 * @remarks
 * A `Reference` is recognized structurally — a record with a string
 * `reference` — because that field name belongs to no other FHIR R4 element.
 * An `identifier` the source already stated is **kept**: it is better
 * provenance than the one this would synthesize.
 */
const rewriteReferenceRecord = (
  record: Record<string, unknown>,
  rewrite: ReferenceRewrite
): Record<string, unknown> => {
  const reference = record['reference']
  if (typeof reference !== 'string') return record
  const parsed = parseRelativeReference(reference)
  if (parsed === null) return record
  const rewritten = rewrite(parsed)
  if (rewritten === null) return record
  return {
    ...record,
    reference: rewritten.reference,
    identifier: record['identifier'] ?? rewritten.identifier,
  }
}

/**
 * Rebuild any decoded value with every relative reference inside it rewritten.
 *
 * @param value - The value to walk
 * @param rewrite - The rewrite to apply to each relative reference found
 * @returns A structurally identical value, differing only where the rewrite
 *   returned a replacement
 *
 * @remarks
 * Depth-first and bottom-up, so a `Reference` nested in a backbone element is
 * already rewritten by the time its container is rebuilt. `Object.fromEntries`
 * rather than assigning into a literal, because assignment _sets_ a property
 * where this must _define_ one: a record carrying a `__proto__` key — which
 * `JSON.parse` produces as an ordinary own property — would otherwise reassign
 * the rebuilt object's prototype instead of copying the field.
 */
const rewriteValue = (value: unknown, rewrite: ReferenceRewrite): unknown => {
  if (Array.isArray(value)) return value.map((item: unknown) => rewriteValue(item, rewrite))
  if (!isPlainRecord(value)) return value
  return rewriteReferenceRecord(
    Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, rewriteValue(child, rewrite)])
    ),
    rewrite
  )
}

/**
 * Rewrite every relative reference in a resource, preserving its type.
 *
 * @param resource - The decoded resource
 * @param rewrite - The rewrite to apply to each relative reference found
 * @returns The same resource with its references replaced
 *
 * @remarks
 * The one place in this slice that asserts a type it cannot prove. The walk
 * recurses through `unknown` because it must reach a `Reference` wherever a
 * schema put one, and TypeScript cannot see that rebuilding a record
 * key-for-key — replacing only two `string`-typed fields with `string`s —
 * preserves the input's type. The provable alternative, enumerating reference
 * fields per resource type, is the design this module rejects (see the module
 * remarks).
 *
 * What backs the assertion is `relative-reference.test.ts`: over generated
 * values, a walk that rewrites nothing is deep-equal to its input, and one that
 * rewrites differs at exactly the reference fields. A regression in
 * structure-preservation fails a test rather than surviving behind the cast.
 */
const withRewrittenReferences = <TValue>(resource: TValue, rewrite: ReferenceRewrite): TValue =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see remarks: structure-preservation is verified by property test, not by the type system
  rewriteValue(resource, rewrite) as TValue

/**
 * Every relative reference a value contains, in walk order and with repeats.
 *
 * @param value - The value to walk
 * @returns Each relative reference found, as many times as it occurs
 *
 * @remarks
 * A rewrite that records and declines to replace, rather than a second
 * recursion — so "which references exist" and "which get rewritten" cannot
 * disagree about what counts as one. Callers needing each reference once
 * deduplicate; a resource naming the same subject twice is ordinary.
 */
const relativeReferencesIn = (value: unknown): readonly RelativeReference[] => {
  const found: RelativeReference[] = []
  rewriteValue(value, (reference) => {
    found.push(reference)
    return null
  })
  return found
}

export {
  isPlainRecord,
  parseRelativeReference,
  RELATIVE_REFERENCE_PATTERN,
  type ReferenceRewrite,
  type RelativeReference,
  relativeReferencesIn,
  type RewrittenReference,
  withRewrittenReferences,
}
