/**
 * A detached resource: a FHIR resource as it stands outside any server, which
 * is how every decoder hands a record to the import stage, and how a decoder
 * writes one.
 *
 * @packageDocumentation
 */
import {
  IdentifierAndReference,
  type IdentifierType,
  type ReferenceType,
} from '@wildflowerhealthio/fhir-r4/data-types'
import { localResourceId } from '@wildflowerhealthio/fhir-r4/identity'
import { type FhirResource, ResourceType } from '@wildflowerhealthio/fhir-r4/resources'
import {
  Array as Arr,
  Option,
  type ParseResult,
  pipe,
  Predicate,
  Schema,
  type Effect,
} from 'effect'

import { identifierOf, mapReferences } from './reference-table.ts'

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
 * writes it there ({@link keyIdentifierWire}, or {@link fromServerRecord}
 * for a server's record), and a record whose source gave it no id is keyed by whatever
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

/** The literal reference to the record of `resourceType` stored under `id`, `<Type>/<id>`. */
const referenceToStoredId = (resourceType: string, id: string): string => `${resourceType}/${id}`

/**
 * The literal reference the import stage stores the record of `resourceType`
 * keyed by `key` under, `<Type>/<localResourceId(key.system, Type, key.value)>`:
 * the one spelling of a keyed record's stored reference.
 */
const storedReferenceOf = (resourceType: string, { system, value }: Key): string =>
  referenceToStoredId(resourceType, localResourceId(system, resourceType, value))

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
 * The id each keyed record of one batch is stored under, by the record's type
 * and key: {@link storedIdsOf} builds it, {@link storedIdIfInBatch} and
 * {@link storedReferenceIfInBatch} read it.
 *
 * @remarks
 * What `adopt` takes a keyed record's id from and resolves a logical
 * reference against, as a FHIR server processing a transaction resolves a
 * conditional reference against the bundle. Each id is derived once, when the
 * batch is read, so a reference whose target is not in the batch costs a
 * lookup and no `localResourceId`.
 */
type StoredIds = ReadonlyMap<string, string>

/**
 * How {@link StoredIds} spells a record's type and key: unambiguous whatever
 * the system and value hold.
 */
const typedKeyText = (resourceType: string, { system, value }: Key): string =>
  JSON.stringify([resourceType, system, value])

/**
 * The id every keyed record of `records` is stored under
 * ({@link keyedIdOf}), derived once each.
 */
const storedIdsOf = (records: Iterable<Type>): StoredIds =>
  new Map(
    Arr.filterMap(Arr.fromIterable(records), (record) =>
      Option.map(keyOf(record), (key): readonly [string, string] => [
        typedKeyText(record.resourceType, key),
        localResourceId(key.system, record.resourceType, key.value),
      ])
    )
  )

/**
 * The id the record of `resourceType` keyed by `key` is stored under, when it
 * is a record of the batch `storedIds` was built from; `None` otherwise.
 */
const storedIdIfInBatch = (
  storedIds: StoredIds,
  resourceType: string,
  key: Key
): Option.Option<string> => Option.fromNullable(storedIds.get(typedKeyText(resourceType, key)))

/**
 * The literal reference the record of `resourceType` keyed by `key` is stored
 * under ({@link storedReferenceOf}), when it is a record of the batch
 * `storedIds` was built from; `None` otherwise.
 */
const storedReferenceIfInBatch = (
  storedIds: StoredIds,
  resourceType: string,
  key: Key
): Option.Option<string> =>
  Option.map(storedIdIfInBatch(storedIds, resourceType, key), (id) =>
    referenceToStoredId(resourceType, id)
  )

/**
 * FHIR R4's relative-reference grammar: a resource-type token, `/`, and a
 * logical id.
 *
 * @remarks
 * The only literal {@link fromServerRecord} reads a target's id from, and only when the
 * token is an R4 resource type (`ResourceType.is`). Everything else is left
 * verbatim — a `#fragment` contained reference, a `urn:uuid:`, a foreign
 * absolute URL, a versioned `Type/id/_history/v`, any id carrying a character
 * outside the spec's set (a space, a slash), and a token R4 does not define
 * (carebook's `PrescriptionOrder`) all pass through untouched.
 */
const RELATIVE_REFERENCE = /^([A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})$/

/**
 * `new URL`, memoised for one {@link fromServerRecord}.
 *
 * @remarks
 * `new URL` is the most expensive thing in this file, and a page of 250
 * `Observation`s carries a few thousand references — so each system is parsed
 * once. The one instance is written into every `Identifier.system` in that
 * system, so they alias: **treat it as immutable**, and clone before mutating.
 *
 * A system that is not an absolute URI throws a `TypeError` here. That
 * reaches the caller as a defect rather than as a failed parse, deliberately:
 * it means the source is misconfigured, not that a response was bad.
 */
const memoisedUrlOf = (): ((url: string) => URL) => {
  const urls = new Map<string, URL>()
  return (url) => {
    const known = urls.get(url)
    if (known !== undefined) {
      return known
    }
    const parsed = new URL(url)
    urls.set(url, parsed)
    return parsed
  }
}

/**
 * The system a FHIR server at `baseUrl` keys its records of `resourceType` in,
 * `<baseUrl>/<Type>`: the `[base]/[type]` of its `[base]/[type]/[id]`, since
 * a FHIR server's ids are unique per type.
 */
const serverSystemOf = (baseUrl: string, resourceType: string): string =>
  `${baseUrl}/${resourceType}`

/**
 * A reference literal as the relative `Type/id` {@link fromServerRecord} reads a
 * target's id from: a FHIR server at `baseUrl` may spell a reference to its own
 * record absolutely, `<baseUrl>/Type/id`, which is the same target as
 * `Type/id`, so that prefix is read back off. Any other literal as it is.
 */
const relativise = (baseUrl: string, reference: string): string =>
  reference.startsWith(`${baseUrl}/`) ? reference.slice(baseUrl.length + 1) : reference

/**
 * A reference whose literal, relativised against `baseUrl`, is a relative
 * `Type/id`, as the logical reference to its target: no literal, `type` the
 * target's type, and `identifier` the target's key, `<baseUrl>/<Type>` and
 * the id as its value. Every other reference exactly as it is.
 *
 * @remarks
 * The literal is read through {@link relativise}, so a FHIR server's absolute
 * `<baseUrl>/Type/id` detaches exactly as its `Type/id`. A literal that is
 * still not a relative `Type/id` of an R4 resource type once relativised — a
 * `#fragment`, a `urn:uuid:`, a foreign absolute URL, a versioned
 * `Type/id/_history/v`, a search URL, an id past 64 characters, a base that is
 * only a prefix of the server's, a type R4 does not define — is kept in its
 * original spelling, absolute or not, its `identifier` included. A reference
 * with no literal (an identifier-only or display-only one) is kept as the
 * source wrote it.
 *
 * An `identifier` the server had also put on a reference it is turned
 * logical is **replaced** by the target's key: the slot is 0..1, and the key
 * is what names the target now that the literal is gone. A FHIR server may
 * send both on one reference, so this is not a rule only one source needs.
 * The target carries its own identifiers, so the server's are not lost when it
 * was decoded too.
 * `display` and `extension` are kept.
 */
const detachReference =
  (baseUrl: string, urlOf: (url: string) => URL) =>
  (reference: ReferenceType): ReferenceType => {
    const match =
      reference.reference === null
        ? null
        : RELATIVE_REFERENCE.exec(relativise(baseUrl, reference.reference))
    const resourceType = match?.[1]
    const id = match?.[2]
    if (resourceType === undefined || id === undefined || !ResourceType.is(resourceType)) {
      return reference
    }
    return {
      ...reference,
      reference: null,
      type: resourceType,
      identifier: identifierOf(urlOf(serverSystemOf(baseUrl, resourceType)), id),
    }
  }

/**
 * A record a FHIR server served, detached: the server's id becomes the key
 * identifier in `<base>/<Type>`, and references to the server's own records
 * become logical.
 *
 * @param baseUrl - The server's base URL, the `[base]` of its
 *   `[base]/[type]/[id]`
 * @returns A function from one served resource to its detached form, of the
 *   same resource type
 *
 * @remarks
 * For a response kind whose records really were a FHIR server's (a FHIR R4
 * server's reads, carebook's STU3 searchset), as a private step of its
 * `parse`. A decoder that synthesizes its records writes them detached
 * instead ({@link keyIdentifierWire}, {@link logicalReferenceWire}).
 *
 * - `id` becomes `null`. When it was set and the type has an `identifier`
 *   element, `{ system: <baseUrl>/<Type>, value: id }` is prepended as
 *   `identifier[0]`, the record's key; every identifier the server wrote is
 *   kept behind it. A `Binary` (no `identifier` element) and a record with no
 *   `id` keep only what they had, so they are keyless unless the server's own
 *   first identifier names them.
 * - Every reference the per-type table ({@link mapReferences}) reaches is run
 *   through {@link detachReference}.
 *
 * There is deliberately no "already keyed?" guard: a server that publishes
 * its own id as an identifier in the same system yields a benign duplicate.
 */
const fromServerRecord = (baseUrl: string) => {
  const urlOf = memoisedUrlOf()
  const detachReferences = mapReferences(detachReference(baseUrl, urlOf))
  return <TResource extends FhirResource>(resource: TResource): Detached<TResource> => {
    const detached = detachReferences(resource)
    const { id } = resource
    const keyed: Type =
      id !== null && hasIdentifier(detached)
        ? {
            ...detached,
            id: null,
            identifier: [
              identifierOf(urlOf(serverSystemOf(baseUrl, detached.resourceType)), id),
              ...detached.identifier,
            ],
          }
        : { ...detached, id: null }
    // `mapReferences` maps each variant to itself, so `keyed` is `resource`'s
    // own type, detached; the type system cannot see that (see its remarks).
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return keyed as Detached<TResource>
  }
}

export {
  decodeUnknown,
  fromServerRecord,
  hasIdentifier,
  isDetached,
  keyedIdOf,
  keyIdentifierWire,
  keyOf,
  logicalReferenceWire,
  storedIdIfInBatch,
  storedIdsOf,
  storedReferenceIfInBatch,
  storedReferenceOf,
}
export type { Detached, Key, StoredIds, Type }
