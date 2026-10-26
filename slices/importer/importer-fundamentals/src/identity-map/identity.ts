/**
 * An identity an import discovers: who a `Patient` or `Practitioner` is, as
 * one identifier under one system, whatever resource carries it.
 *
 * @remarks
 * The identity map keys its rows by {@link key}, so the same person named by a
 * resource in one file and by a bare identifier in another is one row.
 *
 * @packageDocumentation
 */

import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Practitioner, type Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Equivalence, Option, Schema, String as Str } from 'effect'

/** The resource types an identity names. */
type ResourceType = 'Patient' | 'Practitioner'

/** A resource an identity can name: a `Patient` or a `Practitioner`. */
type IdentifiedResource = Patient.Type | Practitioner.Type

/** One person or provider: a resource type and the identifier that names them. */
interface Type {
  readonly resourceType: ResourceType
  readonly system: URL
  readonly value: string
}

const RESOURCE_TYPES: readonly string[] = [
  'Patient',
  'Practitioner',
] satisfies readonly ResourceType[]

/** Whether `resourceType` is one an identity names. */
const isResourceType = (resourceType: string | null): resourceType is ResourceType =>
  resourceType !== null && RESOURCE_TYPES.includes(resourceType)

/** Whether `resource` is a `Patient` or a `Practitioner`. */
const isIdentifiedResource = (resource: {
  readonly resourceType: string
}): resource is IdentifiedResource => isResourceType(resource.resourceType)

/** The identity map's key for `identity`: `resourceType|system|value`. */
const key = (identity: Type): string =>
  `${identity.resourceType}|${identity.system.href}|${identity.value}`

/** Two identities are one when their resource type, system and value agree. */
const equivalence: Equivalence.Equivalence<Type> = Equivalence.mapInput(Equivalence.string, key)

/**
 * The identity `identifier` names for a `resourceType`, or `None` unless it
 * carries both a `system` and a non-empty `value`: an identifier missing
 * either names nobody in particular.
 */
const fromIdentifier = (
  resourceType: ResourceType,
  identifier: IdentifierAndReference.IdentifierType
): Option.Option<Type> =>
  Option.all({
    system: Option.fromNullable(identifier.system),
    value: Option.fromNullable(identifier.value).pipe(Option.filter(Str.isNonEmpty)),
  }).pipe(Option.map(({ system, value }) => ({ resourceType, system, value })))

/**
 * The identity a `Patient` or `Practitioner` is keyed by: its `identifier[0]`,
 * which adoption fills with the source's own id under the source's system.
 * `None` when that identifier is missing or lacks a system or value.
 */
const ofResource = (resource: IdentifiedResource): Option.Option<Type> =>
  Array.head(resource.identifier).pipe(
    Option.flatMap((identifier) => fromIdentifier(resource.resourceType, identifier))
  )

const decodeIdentifier = Schema.decodeSync(IdentifierAndReference.IdentifierSchema)

/** The identifier `identity` names: its system and value, and nothing else. */
const toIdentifier = (identity: Type): IdentifierAndReference.IdentifierType =>
  decodeIdentifier({ system: identity.system.href, value: identity.value })

/**
 * Whether `identity` is a provider's printed name under
 * `Practitioner.NAME_IDENTIFIER_SYSTEM`: the one id-only identity a
 * Practitioner can be minted for, since the name is all a provider needs.
 */
const isNameIdentity = (identity: Type): boolean =>
  identity.resourceType === 'Practitioner' &&
  identity.system.href === new URL(Practitioner.NAME_IDENTIFIER_SYSTEM).href

/** Whether `identifier` carries both a `system` and a `value`, so it can link two records. */
const isLinkable = (identifier: IdentifierAndReference.IdentifierType): boolean =>
  identifier.system !== null && identifier.value !== null && Str.isNonEmpty(identifier.value)

/**
 * `resource` with every linkable identifier of `candidates` it does not
 * already carry appended, after its own, matched on `system` + `value`.
 *
 * @remarks
 * Nothing but `identifier` changes, and the resource's own identifiers stay as
 * they are, so a stored resource's demographics come back byte-identical.
 * Returns `resource` itself when it gains nothing, which makes the merge
 * idempotent.
 */
const withIdentifiers = <TResource extends IdentifiedResource>(
  resource: TResource,
  candidates: readonly IdentifierAndReference.IdentifierType[]
): TResource => {
  const missing = Array.dedupeWith(
    Array.differenceWith(IdentifierAndReference.identifierEquivalence)(
      candidates.filter(isLinkable),
      resource.identifier
    ),
    IdentifierAndReference.identifierEquivalence
  )
  return missing.length === 0
    ? resource
    : { ...resource, identifier: [...resource.identifier, ...missing] }
}

export {
  equivalence,
  fromIdentifier,
  isIdentifiedResource,
  isLinkable,
  isNameIdentity,
  isResourceType,
  key,
  ofResource,
  toIdentifier,
  withIdentifiers,
}
export type { IdentifiedResource, ResourceType, Type }
