/**
 * A logical reference: what a FHIR `Reference` names when it names its target
 * by `type` and `identifier` rather than by a literal `reference`, as the
 * slice of the target resource it names it by.
 *
 * @remarks
 * Shaped as a slice of a keyed resource, its `resourceType` and its
 * `identifier`, so a resource that carries one identifier, or a plan of one,
 * is a logical reference to itself as it stands
 * (`Pick<Resource, 'resourceType' | 'identifier'>`). `identifier` holds
 * exactly one identifier, since `Reference.identifier` is 0..1: the slice
 * holds the one identifier the reference names, never the target's others.
 *
 * @packageDocumentation
 */
import { Equivalence, Option } from 'effect'

import {
  type IdentifierType,
  isQualifiedIdentifier,
  type QualifiedIdentifierType,
  type ReferenceType,
} from '../data-types/complex/identifier-and-reference.ts'
import * as ResourceType from './resource-type.ts'

/**
 * One logical reference: the R4 resource type it names, and the one
 * qualified identifier that names it.
 *
 * @typeParam TResourceType - The types it may name; a caller narrows it to
 *   the types it handles
 */
interface Type<TResourceType extends ResourceType.Type = ResourceType.Type> {
  readonly resourceType: TResourceType
  readonly identifier: readonly [QualifiedIdentifierType]
}

/** The logical reference to the `resourceType` record `identifier` names. */
const make = <TResourceType extends ResourceType.Type>(
  resourceType: TResourceType,
  identifier: QualifiedIdentifierType
): Type<TResourceType> => ({ resourceType, identifier: [identifier] })

/**
 * How a logical reference is spelt as a key: its `resourceType`, `system`
 * and `value` as JSON, so no separator inside a system or value can make two
 * spell alike. An identifier's other fields (`use`, `type`, `period`,
 * `assigner`, `extension`) do not name what it identifies, so they are left
 * out.
 */
const key = ({ resourceType, identifier: [{ system, value }] }: Type): string =>
  JSON.stringify([resourceType, system.href, value])

/** Two logical references name one record when their type, system and value agree ({@link key}). */
const equivalence: Equivalence.Equivalence<Type> = Equivalence.mapInput(Equivalence.string, key)

/** The logical reference `identifier` makes to a `resourceType` record; `None` unless the identifier is qualified. */
const tryFromIdentifier = <TResourceType extends ResourceType.Type>(
  resourceType: TResourceType,
  identifier: IdentifierType
): Option.Option<Type<TResourceType>> =>
  isQualifiedIdentifier(identifier) ? Option.some(make(resourceType, identifier)) : Option.none()

/**
 * The logical reference `reference` is: no literal `reference`, an R4
 * resource type as its `type`, and a qualified `identifier`. `None` for a
 * literal reference, an untyped or display-only one, and one whose `type`
 * names no R4 resource.
 */
const tryFromReference = (reference: ReferenceType): Option.Option<Type> => {
  const { identifier, type } = reference
  return reference.reference !== null ||
    type === null ||
    !ResourceType.is(type) ||
    identifier === null
    ? Option.none()
    : tryFromIdentifier(type, identifier)
}

export { equivalence, key, make, tryFromIdentifier, tryFromReference }
export type { Type }
