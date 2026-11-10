import type { TimelessDateFromString } from '@wildflowerhealthio/kitchen-sink/schema'

import { type HumanName, IdentifierAndReference } from '../data-types/index.ts'
import type { FhirResource } from '../resources/fhir-resource.ts'
import type * as LogicalReference from '../resources/logical-reference.ts'
import type * as ResourceType from '../resources/resource-type.ts'

/**
 * What a record is matched against the store by, as FHIR's `$match` takes a
 * resource: the slice of the record a match reads.
 *
 * @remarks
 * Shaped as a slice of a resource (`resourceType`, its qualified
 * `identifier`s, and a person's `name`s and `birthDate`), so a decoded record
 * and a logical reference reduce to the same thing: a logical reference is a
 * query with one identifier and no demographics.
 *
 * @packageDocumentation
 */

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
  /** A person's names, as the record gives them; none for any other record. */
  readonly name: readonly (typeof HumanName.Schema.Type)[]
  /** A person's birth date; `null` when the record states none, and for any record not a person. */
  readonly birthDate: typeof TimelessDateFromString.Type | null
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

/** The names and birth date of `resource` when it is a person; none for any other record. */
const demographicsOf = (resource: FhirResource): Pick<Type, 'name' | 'birthDate'> =>
  resource.resourceType === 'Patient' || resource.resourceType === 'Practitioner'
    ? { name: resource.name, birthDate: resource.birthDate }
    : { name: [], birthDate: null }

/** The query matching `resource`: its type, qualified identifiers and, for a person, demographics. */
const fromResource = <TResource extends FhirResource>(
  resource: TResource
): Type<TResource['resourceType']> => {
  const anyResource: FhirResource = resource
  return {
    resourceType: resource.resourceType,
    identifier: qualifiedIdentifiersOf(anyResource),
    ...demographicsOf(anyResource),
  }
}

/** The query matching the record `logicalReference` names: its one identifier, nothing else known. */
const fromLogicalReference = <TResourceType extends ResourceType.Type>(
  logicalReference: LogicalReference.Type<TResourceType>
): Type<TResourceType> => ({
  resourceType: logicalReference.resourceType,
  identifier: logicalReference.identifier,
  name: [],
  birthDate: null,
})

export { fromLogicalReference, fromResource }
export type { Type }
