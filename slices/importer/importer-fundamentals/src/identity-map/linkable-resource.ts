/**
 * The resources the identity map links: a `Patient` or a `Practitioner`, the
 * types a referent can have a resource for.
 *
 * @packageDocumentation
 */

import { HumanName, IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Patient, Practitioner } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Match, Option } from 'effect'

import * as Identity from './identity.ts'

/** A `Patient` or a `Practitioner`. */
type Type = Patient.Type | Practitioner.Type

/** A linkable resource stored on, or bound for, the device: one with an `id`. */
type WithId =
  | (Patient.Type & { readonly id: string })
  | (Practitioner.Type & { readonly id: string })

const matchResourceType = Match.discriminator('resourceType')

/** Whether `resource` is one the identity map links. */
const is = (resource: { readonly resourceType: string }): resource is Type =>
  Identity.isResourceType(resource.resourceType)

/** `resource`'s relative literal reference, `Type/<id>`: what a mention of it carries. */
const literalReferenceOf = (resource: WithId): string => `${resource.resourceType}/${resource.id}`

/**
 * The identity `resource` is keyed by: its `identifier[0]`, which adoption
 * fills with the source's own id under the source's system. `None` when that
 * identifier is missing or names nothing.
 */
const maybeIdentityOf = (resource: Type): Option.Option<Identity.Type> =>
  Array.head(resource.identifier).pipe(
    Option.flatMap((identifier) => Identity.fromIdentifier(resource.resourceType, identifier))
  )

/**
 * The name `resource`'s first `name` renders to, or `None` when it renders
 * blank. The first name, because the derived identifiers read it.
 */
const maybeFirstNameOf = (resource: Type): Option.Option<string> =>
  Option.fromNullable(HumanName.displayName(resource.name.slice(0, 1)))

/**
 * The identifier `resource`'s own demographics derive, under a Wildflower
 * system: name and birth date for a Patient, the printed name for a
 * Practitioner. `None` when they do not allow one.
 */
const maybeDerivedIdentifier = (
  resource: Type
): Option.Option<IdentifierAndReference.IdentifierType> =>
  Match.value(resource).pipe(
    matchResourceType('Patient', Patient.nameBirthDateIdentifier),
    matchResourceType('Practitioner', (practitioner) =>
      Option.flatMap(maybeFirstNameOf(practitioner), Practitioner.nameIdentifier)
    ),
    Match.exhaustive
  )

/**
 * What a review shows for `resource`: its first name, plus the birth date for
 * a Patient, or `fallback` when it has neither.
 */
const labelOf = (resource: Type, fallback: string): string => {
  const birthDate = Match.value(resource).pipe(
    matchResourceType('Patient', (patient) => patient.birthDate),
    matchResourceType('Practitioner', () => null),
    Match.exhaustive
  )
  const parts = [
    ...Option.toArray(maybeFirstNameOf(resource)),
    ...(birthDate === null ? [] : [birthDate]),
  ]
  return parts.length === 0 ? fallback : parts.join(' · ')
}

/**
 * The provisional resource `identity` alone stands for, or `None` when nothing
 * can: a provider's printed name stands for a `Practitioner`
 * (`Practitioner.tryFromNameIdentifier`); no identity stands for a `Patient`,
 * who is never less than a demographic record.
 *
 * @remarks
 * Exhaustive over the resource types an identity names, so a type with no
 * provisional form says so here rather than by omission.
 */
const maybeProvisionalFor = (identity: Identity.Type): Option.Option<WithId> =>
  Match.value(identity).pipe(
    Match.when({ resourceType: 'Practitioner' }, (named) =>
      Practitioner.tryFromNameIdentifier(Identity.toIdentifier(named))
    ),
    Match.when({ resourceType: 'Patient' }, () => Option.none()),
    Match.exhaustive
  )

/**
 * `resource` with every naming identifier of `identifiersToAssume` it does not
 * already carry appended after its own, matched on `system` + `value`: assumed
 * as one assumes an identity, not presumed.
 *
 * @remarks
 * Nothing but `identifier` changes, and the resource's own identifiers stay as
 * they are, so a stored resource's demographics come back byte-identical.
 * Returns `resource` itself when there is nothing new to assume, which is what
 * makes the identity map idempotent.
 */
const assumesIdentifiers = <TResource extends Type>(
  resource: TResource,
  identifiersToAssume: readonly IdentifierAndReference.IdentifierType[]
): TResource => {
  const newIdentifiersToAssume = Array.dedupeWith(
    Array.differenceWith(IdentifierAndReference.identifierEquivalence)(
      identifiersToAssume.filter(Identity.isNaming),
      resource.identifier
    ),
    IdentifierAndReference.identifierEquivalence
  )
  return newIdentifiersToAssume.length === 0
    ? resource
    : { ...resource, identifier: [...resource.identifier, ...newIdentifiersToAssume] }
}

export {
  assumesIdentifiers,
  is,
  labelOf,
  literalReferenceOf,
  maybeDerivedIdentifier,
  maybeIdentityOf,
  maybeProvisionalFor,
}
export type { Type, WithId }
