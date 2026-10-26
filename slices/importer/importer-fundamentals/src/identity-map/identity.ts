/**
 * An identity an import discovers: who or what an identifier names, as one
 * identifier under one system, whatever resource or reference carries it.
 *
 * @remarks
 * The identity map keys its referents by {@link key}, so the same person named
 * by a resource in one file and by a bare identifier in another is one
 * referent. This module holds the value and nothing about linking it.
 *
 * @packageDocumentation
 */

import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Equivalence, Option, Schema, String as Str } from 'effect'

/** The resource types an identity can name. */
type ResourceType = 'Patient' | 'Practitioner'

/** One identity: the resource type it names, and the identifier that names it. */
interface Type {
  readonly resourceType: ResourceType
  readonly system: URL
  readonly value: string
}

const RESOURCE_TYPES: readonly string[] = [
  'Patient',
  'Practitioner',
] satisfies readonly ResourceType[]

/** Whether `resourceType` is one an identity can name. */
const isResourceType = (resourceType: string | null): resourceType is ResourceType =>
  resourceType !== null && RESOURCE_TYPES.includes(resourceType)

/** The identity map's key for `identity`: `resourceType|system|value`. */
const key = (identity: Type): string =>
  `${identity.resourceType}|${identity.system.href}|${identity.value}`

/** Two identities are one when their resource type, system and value agree. */
const equivalence: Equivalence.Equivalence<Type> = Equivalence.mapInput(Equivalence.string, key)

/**
 * Whether `identifier` carries both a `system` and a non-empty `value`, so it
 * names something in particular: an identifier missing either names nothing.
 */
const isNaming = (identifier: IdentifierAndReference.IdentifierType): boolean =>
  identifier.system !== null && identifier.value !== null && Str.isNonEmpty(identifier.value)

/** The identity `identifier` names for a `resourceType`, or `None` unless it {@link isNaming}. */
const fromIdentifier = (
  resourceType: ResourceType,
  identifier: IdentifierAndReference.IdentifierType
): Option.Option<Type> =>
  Option.all({
    system: Option.fromNullable(identifier.system),
    value: Option.fromNullable(identifier.value).pipe(Option.filter(Str.isNonEmpty)),
  }).pipe(Option.map(({ system, value }) => ({ resourceType, system, value })))

const decodeIdentifier = Schema.decodeSync(IdentifierAndReference.IdentifierSchema)

/** The identifier `identity` names: its system and value, and nothing else. */
const toIdentifier = (identity: Type): IdentifierAndReference.IdentifierType =>
  decodeIdentifier({ system: identity.system.href, value: identity.value })

export { equivalence, fromIdentifier, isNaming, isResourceType, key, toIdentifier }
export type { ResourceType, Type }
