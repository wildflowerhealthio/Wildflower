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
 * resource the store does not have. The two have to move together, which is
 * what this module makes possible: it locates every relative reference in a
 * decoded value regardless of which field it sits in, and rebuilds the value
 * with each one replaced.
 *
 * It is deliberately field-agnostic rather than a list of known reference
 * slots. There are ~35 `Reference` fields across the six resources this slice
 * models, several nested inside backbone elements
 * (`MedicationDispense.performer[].actor`), and the set grows every time a
 * schema gains a field — an enumeration would be stale on arrival and would
 * fail *silently*, leaving exactly the dangling references it was written to
 * prevent.
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
 * one: derivation is one-way, so a reference rewritten to `Patient/rexall-3f9a…`
 * would otherwise lose all trace of the `Patient/uid-abc` the source wrote.
 * FHIR allows a reference to carry both a literal `reference` and a logical
 * `identifier`, so nothing has to be dropped to record it.
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
 *   history, so no derived id could resolve it either way. Excluded by the id
 *   admitting no second slash — which also means a source id that *contains* a
 *   slash is left alone, since the relative form cannot name one unambiguously
 *   for anybody, this module included.
 *
 * The id part is deliberately **not** held to FHIR's `[A-Za-z0-9-.]{1,64}`,
 * even though a conformant reference satisfies it. A source that assigns ids
 * FHIR would reject is the normal case here — it is the reason ids are derived
 * at all — and the resource carrying such an id is re-keyed regardless. Holding
 * *references* to the stricter rule would therefore rewrite the resource and
 * leave every pointer to it behind, which is precisely the breakage this
 * module exists to prevent (a property test in
 * `adopt-source-identity.test.ts` caught it).
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
 * **The prototype check is load-bearing, not defensive.** A decoded FHIR value
 * holds class instances — `Identifier.system` and `Resource.implicitRules` are
 * `URL`s — and a `URL`'s state lives behind prototype accessors, so
 * `Object.entries` reports it as having *no* properties. Rebuilding one from
 * its entries would hand back an empty object literal, quietly erasing the
 * field. Only plain records are rebuilt; everything else is passed through by
 * reference.
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
 *
 * An `identifier` the source already stated is **kept**: it is that source's
 * own logical reference, which is strictly better provenance than the one this
 * would synthesize, and overwriting it would discard information to record
 * information.
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
 * Depth-first and bottom-up: children are rebuilt before their parent is
 * examined, so a `Reference` nested in a backbone element is already rewritten
 * by the time its container is rebuilt. Non-record, non-array values (strings,
 * numbers, `URL`s, `null`) are returned as they are.
 *
 * `Object.fromEntries` rather than assigning into a literal, because assignment
 * *sets* a property where this must *define* one: a record carrying a
 * `__proto__` key — which `JSON.parse` produces as an ordinary own property, and
 * a FHIR extension may legitimately hold — would otherwise reassign the
 * rebuilt object's prototype instead of copying the field.
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
 * The one place in this slice that asserts a type it cannot prove. The walk is
 * necessarily untyped — it recurses through `unknown` because it must reach a
 * `Reference` wherever a schema happens to put one — and TypeScript cannot see
 * that rebuilding a record key-for-key, replacing only two `string`-typed
 * fields with `string`s, preserves the input's type. Enumerating the reference
 * fields per resource type instead would be provable, but it is the very design
 * this module rejects (see the module remarks): it goes stale silently.
 *
 * What backs the assertion is the property test in
 * `relative-reference.test.ts`: over arbitrary decoded resources, a walk whose
 * rewrite returns `null` everywhere is deep-equal to its input, and a walk that
 * does rewrite differs from its input at exactly the reference fields. A
 * regression in the walk's structure-preservation therefore fails a test rather
 * than surviving behind the cast.
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
 * Implemented as a rewrite that records and declines to replace, rather than as
 * a second recursion — so "which references exist" and "which references get
 * rewritten" cannot disagree about what counts as one. Callers that need each
 * reference once (to derive its id, say) deduplicate; a resource naming the
 * same subject twice is ordinary.
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
