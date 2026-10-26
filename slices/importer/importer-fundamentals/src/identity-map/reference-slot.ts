/**
 * The references a resource names its patient and providers by: its
 * top-level `subject`, `requester` and `performer`.
 *
 * @remarks
 * A reference that names only an identifier carries no type, so the slot it
 * sits in is what says whose identifier it is: a `subject` names a patient, a
 * `requester` or `performer` a provider. `ResourceReferences.map` reaches a
 * reference anywhere but reports no path, so the slots are read here by
 * field, which also gives the identity map's "needs a patient" list its
 * paths.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Match, Option, pipe } from 'effect'

import * as Identity from './identity.ts'

/** The fields a slot sits in. */
type Field = 'subject' | 'requester' | 'performer'

/** One reference in a slot, with its path in the resource. */
interface Type {
  readonly field: Field
  /** `subject`, `requester`, `performer`, `performer[1]` or `performer[0].actor`. */
  readonly path: string
  readonly reference: IdentifierAndReference.ReferenceType
}

/** The resource type a reference in each field names when it states none. */
const FIELD_RESOURCE_TYPE: Readonly<Record<Field, Identity.ResourceType>> = {
  subject: 'Patient',
  requester: 'Practitioner',
  performer: 'Practitioner',
}

const slot =
  (field: Field, path: string) =>
  (reference: IdentifierAndReference.ReferenceType | null): readonly Type[] =>
    reference === null ? [] : [{ field, path, reference }]

/** The references in `resource`'s top-level `performer`, of whichever shape its type gives it. */
const performerSlots = (resource: FhirResource): readonly Type[] =>
  Match.value(resource).pipe(
    Match.discriminator('resourceType')(
      'DiagnosticReport',
      'Observation',
      'ServiceRequest',
      (named) =>
        named.performer.flatMap((reference, index) =>
          slot('performer', `performer[${index}]`)(reference)
        )
    ),
    Match.discriminator('resourceType')('MedicationDispense', 'Procedure', (named) =>
      named.performer.flatMap((performer, index) =>
        slot('performer', `performer[${index}].actor`)(performer.actor)
      )
    ),
    Match.discriminator('resourceType')('MedicationRequest', (request) =>
      slot('performer', 'performer')(request.performer)
    ),
    Match.orElse(() => [])
  )

/** Every reference in `resource`'s `subject`, `requester` and `performer`, in that order. */
const of = (resource: FhirResource): readonly Type[] => [
  ...('subject' in resource ? slot('subject', 'subject')(resource.subject) : []),
  ...('requester' in resource ? slot('requester', 'requester')(resource.requester) : []),
  ...performerSlots(resource),
]

/**
 * The identity a reference in `resource` names by identifier alone: one with
 * no literal `reference` and a linkable `identifier`, whose resource type is
 * its own `type` when that is `Patient` or `Practitioner`, else its slot's.
 * `None` for a literal reference, a display-only one, and an identifier-only
 * one outside the slots that states no type: a prior prescription's number
 * names no person.
 */
const identityOf = (
  resource: FhirResource,
  reference: IdentifierAndReference.ReferenceType
): Option.Option<Identity.Type> => {
  if (reference.reference !== null || reference.identifier === null) return Option.none()
  const { identifier } = reference
  const resourceType = Identity.isResourceType(reference.type)
    ? Option.some(reference.type)
    : pipe(
        of(resource),
        Array.findFirst((found) => found.reference === reference),
        Option.map((found) => FIELD_RESOURCE_TYPE[found.field])
      )
  return Option.flatMap(resourceType, (type) => Identity.fromIdentifier(type, identifier))
}

export { identityOf, of }
export type { Field, Type }
