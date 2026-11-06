/**
 * A linkable logical reference: a logical reference (`fhir-r4`'s
 * `LogicalReference`) narrowed to a type the identity map links.
 *
 * @remarks
 * It is what an identifier-only mention carries, and what a resource's
 * `resourceType` and `identifier[0]` answer to, so the identity map keys its
 * referents by `LogicalReference.key`: the same person named by a resource in
 * one file and by a bare identifier in another is one referent. This module
 * holds the narrowing and nothing about linking it.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import { Option } from 'effect'

/** The resource types a linkable logical reference can name. */
type ResourceType = 'Patient' | 'Practitioner'

/** One linkable logical reference: a logical reference to a type the identity map links. */
type Type = LogicalReference.Type<ResourceType>

/** Every resource type a linkable logical reference can name, in the order a review lists them. */
const RESOURCE_TYPES: readonly ResourceType[] = ['Patient', 'Practitioner']

/** Whether `resourceType` is one a linkable logical reference can name. */
const isResourceType = (resourceType: string | null): resourceType is ResourceType =>
  resourceType !== null && (RESOURCE_TYPES as readonly string[]).includes(resourceType)

/** Whether `logicalReference` names a type the identity map links. */
const isLinkable = (logicalReference: LogicalReference.Type): logicalReference is Type =>
  isResourceType(logicalReference.resourceType)

/**
 * The linkable logical reference `reference` makes: the logical reference
 * it is (`LogicalReference.tryFromReference`), when its type is one the
 * identity map links. `None` for a literal reference, a display-only one, one
 * whose `type` names something else (an `Organization` performer), and an
 * identifier-only one that states no type, which names nothing the map
 * could tell apart from a patient's account number or a prior
 * prescription's number.
 */
const tryFromReference = (reference: IdentifierAndReference.ReferenceType): Option.Option<Type> =>
  Option.filter(LogicalReference.tryFromReference(reference), isLinkable)

export { isLinkable, isResourceType, RESOURCE_TYPES, tryFromReference }
export type { ResourceType, Type }
