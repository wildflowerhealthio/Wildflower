import { Option } from 'effect'

import { IdentifierAndReference } from '../data-types/index.ts'
import type { FhirResource } from '../resources/fhir-resource.ts'
import type * as LogicalReference from '../resources/logical-reference.ts'
import type * as ResourceType from '../resources/resource-type.ts'

/**
 * What a record is matched against the store by, as FHIR's `$match` takes a
 * resource: its type, its qualified identifiers, and the record itself when
 * there is one.
 *
 * @remarks
 * A decoded record and a logical reference reduce to the same thing: a
 * logical reference is a query with one identifier and no record. What a
 * match reads of the record beyond its identifiers is its type's rule's to
 * say (`ResourceMatch`), so the query carries the whole record.
 *
 * @packageDocumentation
 */

/** The resource of `TResourceType` a query carries; `never` for a type nothing decodes. */
type RecordOf<TResourceType extends ResourceType.Type> = FhirResource & {
  readonly resourceType: TResourceType
}

/**
 * One record to match.
 *
 * @typeParam TResourceType - The type of record matched; a caller narrows it
 *   to the types it handles, and its candidates are typed by it
 */
interface Type<TResourceType extends ResourceType.Type = ResourceType.Type> {
  readonly resourceType: TResourceType
  /** The record's identifiers that name something: a stored record carrying any of them is a certain match. */
  readonly identifier: readonly IdentifierAndReference.QualifiedIdentifierType[]
  /** The record matched; `None` for a logical reference, which names a record without giving it. */
  readonly record: Option.Option<RecordOf<TResourceType>>
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

/** The query matching `resource`: its type, its qualified identifiers and the record. */
const fromResource = <TResource extends FhirResource>(
  resource: TResource
): Type<TResource['resourceType']> => ({
  resourceType: resource.resourceType,
  identifier: qualifiedIdentifiersOf(resource),
  record: Option.some(resource),
})

/** The query matching the record `logicalReference` names: its one identifier, no record. */
const fromLogicalReference = <TResourceType extends ResourceType.Type>(
  logicalReference: LogicalReference.Type<TResourceType>
): Type<TResourceType> => ({
  resourceType: logicalReference.resourceType,
  identifier: logicalReference.identifier,
  record: Option.none(),
})

export { fromLogicalReference, fromResource, qualifiedIdentifiersOf }
export type { RecordOf, Type }
