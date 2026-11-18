import { Option } from 'effect'

import { IdentifierAndReference } from '../data-types/index.ts'
import type { FhirResource } from '../resources/fhir-resource.ts'
import type * as LogicalReference from '../resources/logical-reference.ts'
import type * as ResourceType from '../resources/resource-type.ts'

/**
 * What a resource is matched against the store by, as FHIR's `$match` takes
 * one: its type, its qualified identifiers, and the resource itself when
 * there is one.
 *
 * @remarks
 * A decoded resource and a logical reference reduce to the same thing: a
 * logical reference is a query with one identifier and no resource. What a
 * match reads of the resource beyond its identifiers is its type's rule's to
 * say (`ResourceMatch`), so the query carries the whole resource.
 *
 * @packageDocumentation
 */

/** The resource of `TResourceType` a query carries; `never` for a type nothing decodes. */
type ResourceOf<TResourceType extends ResourceType.Type> = FhirResource & {
  readonly resourceType: TResourceType
}

/**
 * One resource to match, or one record a logical reference names.
 *
 * @typeParam TResourceType - The type of resource matched; a caller narrows
 *   it to the types it handles, and its candidates are typed by it
 */
interface Type<TResourceType extends ResourceType.Type = ResourceType.Type> {
  readonly resourceType: TResourceType
  /** The resource's identifiers that name something: a stored resource carrying any of them is a certain match. */
  readonly identifier: readonly IdentifierAndReference.QualifiedIdentifierType[]
  /** The resource matched; `None` for a logical reference, which names a record without giving a copy of it. */
  readonly resource: Option.Option<ResourceOf<TResourceType>>
}

/**
 * The qualified identifiers `resource` carries; none for a `Binary`, which
 * has no `identifier` element in R4.
 */
const qualifiedIdentifiersOf = (
  resource: FhirResource
): readonly IdentifierAndReference.QualifiedIdentifierType[] =>
  resource.resourceType === 'Binary'
    ? []
    : resource.identifier.filter(IdentifierAndReference.isQualifiedIdentifier)

/** The query matching `resource`: its type, its qualified identifiers and the resource. */
const fromResource = <TResource extends FhirResource>(
  resource: TResource
): Type<TResource['resourceType']> => ({
  resourceType: resource.resourceType,
  identifier: qualifiedIdentifiersOf(resource),
  resource: Option.some(resource),
})

/** The query matching the record `logicalReference` names: its one identifier, no resource. */
const fromLogicalReference = <TResourceType extends ResourceType.Type>(
  logicalReference: LogicalReference.Type<TResourceType>
): Type<TResourceType> => ({
  resourceType: logicalReference.resourceType,
  identifier: logicalReference.identifier,
  resource: Option.none(),
})

export { fromLogicalReference, fromResource, qualifiedIdentifiersOf }
export type { ResourceOf, Type }
