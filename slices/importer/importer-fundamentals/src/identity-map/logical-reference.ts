/**
 * A logical reference: FHIR's name for a `Reference` that names its target by
 * `type` and `identifier` rather than by a literal `reference`, narrowed to a
 * type the identity map links and a qualified identifier.
 *
 * @remarks
 * It is what an identifier-only mention carries, and what a resource's
 * `resourceType` and `identifier[0]` answer to, so the identity map keys its
 * referents by {@link key}: the same person named by a resource in one file
 * and by a bare identifier in another is one referent. This module holds the
 * value and nothing about linking it.
 *
 * @packageDocumentation
 */

import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Equivalence, Option } from 'effect'

/** The resource types a logical reference in the identity map can name. */
type ResourceType = 'Patient' | 'Practitioner'

/** One logical reference: the resource type it names, and the qualified identifier that names it. */
interface Type extends Pick<IdentifierAndReference.ReferenceType, 'type' | 'identifier'> {
  readonly type: ResourceType
  readonly identifier: IdentifierAndReference.QualifiedIdentifierType
}

const RESOURCE_TYPES: readonly string[] = [
  'Patient',
  'Practitioner',
] satisfies readonly ResourceType[]

/** Whether `resourceType` is one a logical reference in the identity map can name. */
const isResourceType = (resourceType: string | null): resourceType is ResourceType =>
  resourceType !== null && RESOURCE_TYPES.includes(resourceType)

/** The identity map's key for `logicalReference`: `type|system|value`. */
const key = ({ type, identifier }: Type): string =>
  `${type}|${identifier.system.href}|${identifier.value}`

/** Two logical references name one thing when their type, system and value agree. */
const equivalence: Equivalence.Equivalence<Type> = Equivalence.mapInput(Equivalence.string, key)

/** The logical reference `identifier` makes to a `type`, or `None` unless the identifier is qualified. */
const maybeOf = (
  type: ResourceType,
  identifier: IdentifierAndReference.IdentifierType
): Option.Option<Type> =>
  IdentifierAndReference.isQualifiedIdentifier(identifier)
    ? Option.some({ type, identifier })
    : Option.none()

/**
 * The logical reference `reference` makes: one with no literal `reference`,
 * a `type` the identity map links, and a qualified `identifier`. `None` for
 * a literal reference, a display-only one, one whose `type` names something
 * else (an `Organization` performer), and an identifier-only one that states
 * no type, which names nothing the map could tell apart from a patient's
 * account number or a prior prescription's number.
 */
const maybeOfReference = (reference: IdentifierAndReference.ReferenceType): Option.Option<Type> =>
  reference.reference === null && reference.identifier !== null && isResourceType(reference.type)
    ? maybeOf(reference.type, reference.identifier)
    : Option.none()

export { equivalence, isResourceType, key, maybeOf, maybeOfReference }
export type { ResourceType, Type }
