/**
 * A mention: each place a resource names its patient or a provider, in its
 * top-level `subject`, `requester` or `performer`.
 *
 * @remarks
 * A reference that names only an identifier carries no type, so the field it
 * sits in is what says whose identifier it is: a `subject` names a patient, a
 * `requester` or `performer` a provider. `ResourceReferences.map` reaches a
 * reference anywhere but reports no path, so these fields are read here by
 * name, which also gives the unlinked-mention list its paths.
 *
 * Why these three and no more: they are the fields through which every
 * resource the importer handles names the person it is about and the
 * clinicians behind it, and the ones the viewing apps read. A reference to a
 * provider elsewhere (`DiagnosticReport.resultsInterpreter`, an
 * `Observation.note[].authorReference`) is still redirected when it names a
 * linked identity, since the redirect walks every reference; it just is not
 * listed as a mention, so it neither makes a referent nor counts as unlinked.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Match, Option, pipe } from 'effect'

import * as LogicalReference from './logical-reference.ts'

/** The fields a mention sits in; see the module remarks for why these three. */
type Field = 'subject' | 'requester' | 'performer'

/**
 * One mention: what the identity map needs to know about it and nothing more.
 * The mentioning resource is not among them, since every reader already holds
 * it.
 */
interface Type {
  /**
   * The field it sits in. It gives an identifier-only reference its type (a
   * `subject` names a `Patient`, the others a `Practitioner`), and it says
   * whether one that lands nowhere is listed even with nothing to name (a
   * `subject` always is).
   */
  readonly field: Field
  /**
   * Where it sits in the resource: `subject`, `requester`, `performer`,
   * `performer[1]` or `performer[0].actor`. What an unlinked mention reports,
   * since `ResourceReferences` gives no path.
   */
  readonly path: string
  /** The reference as the resource carries it: its literal, identifier and `display`. */
  readonly reference: IdentifierAndReference.ReferenceType
}

/** The resource type a mention in each field names when its reference states none. */
const FIELD_RESOURCE_TYPE: Readonly<Record<Field, LogicalReference.ResourceType>> = {
  subject: 'Patient',
  requester: 'Practitioner',
  performer: 'Practitioner',
}

/** The one mention at `path`, in `field`, for a reference that is present; none for a missing one. */
const mentionAt =
  (field: Field, path: string) =>
  (reference: IdentifierAndReference.ReferenceType | null): readonly Type[] =>
    reference === null ? [] : [{ field, path, reference }]

/** The mentions in `resource`'s top-level `performer`, of whichever shape its type gives it. */
const performerMentions = (resource: FhirResource): readonly Type[] =>
  Match.value(resource).pipe(
    Match.discriminator('resourceType')(
      'DiagnosticReport',
      'Observation',
      'ServiceRequest',
      (named) =>
        named.performer.flatMap((reference, index) =>
          mentionAt('performer', `performer[${index}]`)(reference)
        )
    ),
    Match.discriminator('resourceType')('MedicationDispense', 'Procedure', (named) =>
      named.performer.flatMap((performer, index) =>
        mentionAt('performer', `performer[${index}].actor`)(performer.actor)
      )
    ),
    Match.discriminator('resourceType')('MedicationRequest', (request) =>
      mentionAt('performer', 'performer')(request.performer)
    ),
    Match.orElse(() => [])
  )

/** Every mention in `resource`: its `subject`, `requester` and `performer`, in that order. */
const of = (resource: FhirResource): readonly Type[] => [
  ...('subject' in resource ? mentionAt('subject', 'subject')(resource.subject) : []),
  ...('requester' in resource ? mentionAt('requester', 'requester')(resource.requester) : []),
  ...performerMentions(resource),
]

/**
 * The logical reference a reference in `mentioningResource` makes: one with
 * no literal `reference` and a qualified `identifier`, whose type is its own
 * `type` when that is `Patient` or `Practitioner`, else, when it states no
 * type, that of the field it is mentioned in. `None` for a literal reference,
 * a display-only one, one whose `type` names something else (an
 * `Organization` performer), and an identifier-only one outside the mention
 * fields that states no type: a prior prescription's number names no person.
 */
const maybeLogicalReferenceOf = (
  mentioningResource: FhirResource,
  reference: IdentifierAndReference.ReferenceType
): Option.Option<LogicalReference.Type> => {
  if (reference.reference !== null || reference.identifier === null) return Option.none()
  const { identifier } = reference
  const resourceType =
    reference.type === null
      ? pipe(
          of(mentioningResource),
          Array.findFirst((found) => found.reference === reference),
          Option.map((found) => FIELD_RESOURCE_TYPE[found.field])
        )
      : Option.some(reference.type).pipe(Option.filter(LogicalReference.isResourceType))
  return Option.flatMap(resourceType, (type) => LogicalReference.maybeOf(type, identifier))
}

export { maybeLogicalReferenceOf, of }
export type { Field, Type }
