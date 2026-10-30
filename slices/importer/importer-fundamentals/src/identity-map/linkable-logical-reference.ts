/**
 * A linkable logical reference: FHIR's logical reference, a `Reference` that
 * names its target by `type` and `identifier` rather than by a literal
 * `reference`, narrowed to a type the identity map links and a qualified
 * identifier.
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

/** The resource types a linkable logical reference can name. */
type ResourceType = 'Patient' | 'Practitioner'

/** One linkable logical reference: the resource type it names, and the qualified identifier that names it. */
interface Type extends Pick<IdentifierAndReference.ReferenceType, 'type' | 'identifier'> {
  readonly type: ResourceType
  readonly identifier: IdentifierAndReference.QualifiedIdentifierType
}

/** Every resource type a linkable logical reference can name, in the order a review lists them. */
const RESOURCE_TYPES: readonly ResourceType[] = ['Patient', 'Practitioner']

/** Whether `resourceType` is one a linkable logical reference can name. */
const isResourceType = (resourceType: string | null): resourceType is ResourceType =>
  resourceType !== null && (RESOURCE_TYPES as readonly string[]).includes(resourceType)

/** The identity map's key for `logicalReference`: `type|system|value`. */
const key = ({ type, identifier }: Type): string =>
  `${type}|${identifier.system.href}|${identifier.value}`

/** Two logical references name one thing when their type, system and value agree. */
const equivalence: Equivalence.Equivalence<Type> = Equivalence.mapInput(Equivalence.string, key)

/** The linkable logical reference `identifier` makes to a `type`; `None` unless the identifier is qualified. */
const tryFromIdentifier = (
  type: ResourceType,
  identifier: IdentifierAndReference.IdentifierType
): Option.Option<Type> =>
  IdentifierAndReference.isQualifiedIdentifier(identifier)
    ? Option.some({ type, identifier })
    : Option.none()

/**
 * The linkable logical reference `reference` makes: one with no literal
 * `reference`, a `type` the identity map links, and a qualified
 * `identifier`. `None` for a literal reference, a display-only one, one
 * whose `type` names something else (an `Organization` performer), and an
 * identifier-only one that states no type, which names nothing the map
 * could tell apart from a patient's account number or a prior
 * prescription's number.
 */
const tryFromReference = (reference: IdentifierAndReference.ReferenceType): Option.Option<Type> =>
  reference.reference === null && reference.identifier !== null && isResourceType(reference.type)
    ? tryFromIdentifier(reference.type, reference.identifier)
    : Option.none()

export { equivalence, isResourceType, key, RESOURCE_TYPES, tryFromIdentifier, tryFromReference }
export type { ResourceType, Type }
