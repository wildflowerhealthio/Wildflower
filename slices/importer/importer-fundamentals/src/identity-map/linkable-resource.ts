/**
 * The resources the identity map links: a `Patient` or a `Practitioner`, the
 * types a referent can have a resource for.
 *
 * @packageDocumentation
 */

import { HumanName, IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResourceWithId,
  Patient,
  Practitioner,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Array, DateTime, Effect, Match, Option, pipe } from 'effect'

import * as LinkableLogicalReference from './linkable-logical-reference.ts'

/** A `Patient` or a `Practitioner`. */
type Type = Patient.Type | Practitioner.Type

/** A linkable resource stored on, or bound for, the device: one with an `id`. */
type WithId =
  | (Patient.Type & { readonly id: string })
  | (Practitioner.Type & { readonly id: string })

const matchResourceType = Match.discriminator('resourceType')

/** Whether `resource` is one the identity map links. */
const is = (resource: FhirResourceWithId): resource is WithId =>
  LinkableLogicalReference.isResourceType(resource.resourceType)

/** `resource`'s relative literal reference, `Type/<id>`: what a mention of it carries. */
const literalReferenceOf = (resource: WithId): string => `${resource.resourceType}/${resource.id}`

/**
 * The linkable logical reference `resource` is keyed by: its `identifier[0]`,
 * which adoption fills with the source's own id under the source's system.
 * `None` when that identifier is missing or unqualified.
 */
const tryIntoLogicalReference = (resource: Type): Option.Option<LinkableLogicalReference.Type> =>
  Array.head(resource.identifier).pipe(
    Option.flatMap((identifier) =>
      LinkableLogicalReference.tryFromIdentifier(resource.resourceType, identifier)
    )
  )

/**
 * The name `resource` is shown by, `HumanName.displayName`'s pick among its
 * names (a current one first, by use, judged at the clock's now); `None` when
 * none renders.
 */
const maybeDisplayName = (resource: Type): Effect.Effect<Option.Option<string>> =>
  Effect.map(DateTime.now, (now) => Option.fromNullable(HumanName.displayName(resource.name, now)))

/** A Patient's birth date; a Practitioner has none. */
const maybeBirthDate: (resource: Type) => Option.Option<string> = Match.type<Type>().pipe(
  matchResourceType('Patient', (patient) => Option.fromNullable(patient.birthDate)),
  matchResourceType('Practitioner', () => Option.none()),
  Match.exhaustive
)

const DERIVED_IDENTIFIER_SYSTEM_HREFS: ReadonlySet<string> = new Set(
  [Patient.NAME_BIRTH_DATE_IDENTIFIER_SYSTEM, Practitioner.NAME_IDENTIFIER_SYSTEM].map(
    (system) => new URL(system).href
  )
)

/**
 * Whether `identifier` is one demographics derive, under a Wildflower system
 * ({@link maybeDerivedIdentifier}'s), rather than one a source gave: what a
 * resolved resource carries after assuming its own, and what a search by the
 * source's identifiers leaves out.
 */
const isDerivedIdentifier = (identifier: IdentifierAndReference.IdentifierType): boolean =>
  identifier.system !== null && DERIVED_IDENTIFIER_SYSTEM_HREFS.has(identifier.system.href)

/**
 * The identifier `resource`'s own demographics derive, under a Wildflower
 * system: name and birth date for a Patient, the displayed name for a
 * Practitioner. `None` when they do not allow one.
 */
const maybeDerivedIdentifier: (
  resource: Type
) => Effect.Effect<Option.Option<IdentifierAndReference.IdentifierType>> = Match.type<Type>().pipe(
  matchResourceType('Patient', (patient) => Patient.nameBirthDateIdentifier(patient)),
  matchResourceType('Practitioner', (practitioner) =>
    Effect.map(maybeDisplayName(practitioner), Option.flatMap(Practitioner.nameIdentifier))
  ),
  Match.exhaustive
)

/**
 * What a review shows for `resource`: its displayed name, plus the birth date
 * for a Patient, or `fallback` when it has neither.
 */
const labelOf = (resource: Type, fallback: string): Effect.Effect<string> =>
  Effect.map(maybeDisplayName(resource), (displayName) => {
    const parts = [displayName, maybeBirthDate(resource)].flatMap(Option.toArray)
    return parts.length === 0 ? fallback : parts.join(' · ')
  })

/**
 * The provisional resource `logicalReference` alone stands for; `None` when
 * nothing can: a provider's printed name stands for a `Practitioner`
 * (`Practitioner.tryFromNameIdentifier`); nothing stands for a `Patient`, who
 * is never less than a demographic record.
 *
 * @remarks
 * Exhaustive over the resource types a logical reference names, so a type
 * with no provisional form says so here rather than by omission.
 */
const tryProvisionalFrom: (
  logicalReference: LinkableLogicalReference.Type
) => Option.Option<WithId> = Match.type<LinkableLogicalReference.Type>().pipe(
  Match.when({ type: 'Practitioner' }, ({ identifier }) =>
    Practitioner.tryFromNameIdentifier(identifier)
  ),
  Match.when({ type: 'Patient' }, () => Option.none()),
  Match.exhaustive
)

/**
 * `resource` with every qualified identifier of `identifiersToAssume` it does not
 * already carry appended after its own, matched on `system` + `value`: assumed
 * as one assumes an identity, not presumed.
 *
 * @remarks
 * Nothing but `identifier` changes, and the resource's own identifiers stay as
 * they are, so a stored resource's demographics come back byte-identical.
 * Returns `resource` itself when there is nothing new to assume, so a resource
 * the map changes nothing in comes back as the same object.
 */
const assumesIdentifiers = <TResource extends Type>(
  resource: TResource,
  identifiersToAssume: readonly IdentifierAndReference.IdentifierType[]
): TResource => {
  const newIdentifiersToAssume = pipe(
    identifiersToAssume,
    Array.filter(IdentifierAndReference.isQualifiedIdentifier),
    Array.differenceWith(IdentifierAndReference.identifierEquivalence)(resource.identifier),
    Array.dedupeWith(IdentifierAndReference.identifierEquivalence)
  )
  return newIdentifiersToAssume.length === 0
    ? resource
    : { ...resource, identifier: [...resource.identifier, ...newIdentifiersToAssume] }
}

export {
  assumesIdentifiers,
  is,
  isDerivedIdentifier,
  labelOf,
  literalReferenceOf,
  maybeDerivedIdentifier,
  maybeDisplayName,
  tryIntoLogicalReference,
  tryProvisionalFrom,
}
export type { Type, WithId }
