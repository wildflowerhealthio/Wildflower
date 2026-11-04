/**
 * A detached resource: a FHIR resource as it stands outside any server, which
 * is how every decoder hands a record to the import stage, and how a decoder
 * writes one.
 *
 * @packageDocumentation
 */
import { IdentifierAndReference, type IdentifierType } from '@wildflowerhealthio/fhir-r4/data-types'
import { localResourceId } from '@wildflowerhealthio/fhir-r4/identity'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import {
  Array as Arr,
  Option,
  type ParseResult,
  pipe,
  Predicate,
  Schema,
  type Effect,
} from 'effect'

/**
 * `TResource` with no logical id, distributed over a union so each variant
 * keeps its own `resourceType`.
 */
type Detached<TResource extends FhirResource> = TResource extends unknown
  ? TResource & { readonly id: null }
  : never

/**
 * A {@link FhirResource} detached from any server: its `id` is `null`.
 *
 * @remarks
 * FHIR's logical id only means something within the server that assigned it,
 * so a record read out of a source carries none. It names itself by its
 * {@link Key}, its first identifier, when it has one, and it names every other
 * decoded record by a logical reference (`type` and `identifier`, no
 * literal). The import stage (`adopt`) gives it the id it is stored under.
 */
type Type = Detached<FhirResource>

/**
 * What a detached record is keyed by, less its type: its first identifier's
 * `system` (as written in `Identifier.system`, an absolute URI) and `value`.
 */
interface Key {
  readonly system: string
  readonly value: string
}

/**
 * Whether `resource`'s type has an `identifier` element.
 *
 * @remarks
 * Every `fhir-r4` resource schema whose type has the element defaults it to
 * `[]`, so a decoded resource carries the property exactly when R4 gives its
 * type one: a type added to the union needs no edit here. `Binary` is one
 * without it, so a Binary is always keyless.
 */
const hasIdentifier = <TResource extends FhirResource>(
  resource: TResource
): resource is Extract<TResource, { readonly identifier: readonly IdentifierType[] }> =>
  Predicate.hasProperty(resource, 'identifier')

/** Whether `resource` is detached: its `id` is `null`. */
const isDetached = <TResource extends FhirResource>(
  resource: TResource
): resource is Detached<TResource> => resource.id === null

/**
 * Decode an unknown value as a detached record of `resourceSchema`'s type:
 * the resource as the schema decodes it, failing unless it has no `id`.
 *
 * @remarks
 * How a decoder that writes its records detached, as wire with no `id`
 * (keyed by {@link keyIdentifierWire}, naming other records by
 * {@link logicalReferenceWire}), gets them typed as such: a wire that does
 * carry an `id` is a decoder that wrote a server-shaped record by mistake, and
 * fails the decode rather than being stored under a server's id.
 */
const decodeUnknown = <TResource extends FhirResource, TEncoded>(
  resourceSchema: Schema.Schema<TResource, TEncoded>
): ((wire: unknown) => Effect.Effect<Detached<TResource>, ParseResult.ParseError>) =>
  Schema.decodeUnknown(
    resourceSchema.pipe(
      Schema.filter(isDetached, { message: () => 'a detached record carries no id' })
    )
  )

/**
 * The `Identifier` wire a detached record is keyed by, `{ system, value }`:
 * its `identifier[0]`.
 */
const keyIdentifierWire = ({
  system,
  value,
}: Key): typeof IdentifierAndReference.IdentifierSchema.Encoded => ({ system, value })

/**
 * The logical `Reference` wire to the record of `resourceType` keyed by `key`:
 * `type` and the key as `identifier`, no literal.
 *
 * @remarks
 * How a decoder writing its records detached names another record it decodes:
 * `adopt` resolves it to the literal reference that record is stored under
 * when the record is in the batch.
 */
const logicalReferenceWire = (
  resourceType: FhirResource['resourceType'],
  key: Key
): typeof IdentifierAndReference.ReferenceSchema.Encoded => ({
  type: resourceType,
  identifier: keyIdentifierWire(key),
})

/**
 * `record`'s key: its first identifier, when that identifier has both a
 * `system` and a `value`; `None` for a keyless record.
 *
 * @remarks
 * Only `identifier[0]` is read: a decoder that knows a record's own id
 * writes it there ({@link keyIdentifierWire}, or `detach` for a server's
 * record), and a record whose source gave it no id is keyed by whatever
 * identifier the source wrote first. A record with no identifier, an
 * unqualified first one, or no `identifier` element at all (`Binary`) is
 * keyless, and is stored under an id minted for it.
 */
const keyOf = (record: Type): Option.Option<Key> =>
  pipe(
    Option.liftPredicate(record, hasIdentifier),
    Option.flatMap(({ identifier }) => Arr.head(identifier)),
    Option.filter(IdentifierAndReference.isQualifiedIdentifier),
    Option.map(({ system, value }) => ({ system: system.href, value }))
  )

/**
 * The literal reference the import stage stores the record of `resourceType`
 * keyed by `key` under, `<Type>/<localResourceId(key.system, Type, key.value)>`:
 * the one spelling of a keyed record's stored reference.
 */
const storedReferenceOf = (resourceType: string, { system, value }: Key): string =>
  `${resourceType}/${localResourceId(system, resourceType, value)}`

/**
 * The id the import stage stores `record` under when it is keyed:
 * `localResourceId` of its key's system, its type and its key's value.
 * `None` for a keyless record, whose id is minted at import.
 */
const keyedIdOf = (record: Type): Option.Option<string> =>
  Option.map(keyOf(record), ({ system, value }) =>
    localResourceId(system, record.resourceType, value)
  )

/**
 * The literal reference every keyed record of `records` is stored under
 * ({@link storedReferenceOf}), once each.
 *
 * @remarks
 * What `adopt` resolves a logical reference against, as a FHIR server
 * processing a transaction resolves a conditional reference against the
 * bundle: a logical reference resolves when the record it names by key is
 * among `records`, and stays logical when it is not.
 */
const storedReferencesOf = (records: Iterable<Type>): ReadonlySet<string> =>
  new Set(
    Arr.filterMap(Arr.fromIterable(records), (record) =>
      Option.map(keyOf(record), (key) => storedReferenceOf(record.resourceType, key))
    )
  )

export {
  decodeUnknown,
  hasIdentifier,
  isDetached,
  keyedIdOf,
  keyIdentifierWire,
  keyOf,
  logicalReferenceWire,
  storedReferenceOf,
  storedReferencesOf,
}
export type { Detached, Key, Type }
