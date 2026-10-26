/**
 * What the identity review renders: one row per identity a decoded file
 * holds, either a `Patient` / `Practitioner` the decode emitted or a
 * reference that names someone by identifier alone.
 *
 * @packageDocumentation
 */

import { HumanName, IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Patient, Practitioner, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Option, pipe } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import * as Identity from './identity.ts'
import * as ReferenceSlot from './reference-slot.ts'

/** A `Patient` or `Practitioner` the decode emitted, keyed by its `identifier[0]`. */
interface ResourceBacked {
  readonly _tag: 'resource'
  readonly identity: Identity.Type
  /**
   * Every identifier the search for this row tries: the resource's own, then
   * the one its demographics derive ({@link derivedIdentifier}) when they
   * allow one.
   */
  readonly identifiers: readonly IdentifierAndReference.IdentifierType[]
  readonly resource: Identity.IdentifiedResource
  /** The `DecodedFile.Resource` key the resource is reviewed under. */
  readonly reviewKey: string
  readonly label: string
}

/** A reference that names a person or provider by identifier alone, with no resource behind it. */
interface IdOnly {
  readonly _tag: 'reference'
  readonly identity: Identity.Type
  readonly label: string
}

type Type = ResourceBacked | IdOnly

/** The identity map's key for `row`. */
const key = (row: Type): string => Identity.key(row.identity)

/**
 * The name a resource's first `name` renders to, as `HumanName.displayName`
 * renders one name, or `None` when it renders blank. The first name, because
 * the derived identifiers read it.
 */
const firstNameOf = (resource: Identity.IdentifiedResource): Option.Option<string> =>
  Option.fromNullable(HumanName.displayName(resource.name.slice(0, 1)))

/**
 * The identifier `resource`'s demographics derive:
 * `Patient.nameBirthDateIdentifier` for a Patient, `Practitioner.nameIdentifier`
 * of its first name for a Practitioner. `None` when they do not allow one.
 */
const derivedIdentifier = (
  resource: Identity.IdentifiedResource
): Option.Option<IdentifierAndReference.IdentifierType> =>
  resource.resourceType === 'Patient'
    ? Patient.nameBirthDateIdentifier(resource)
    : Option.flatMap(firstNameOf(resource), Practitioner.nameIdentifier)

/**
 * What a row shows for `resource`: its first name, plus the birth date for a
 * Patient, or `fallback` when it has neither.
 */
const labelOf = (resource: Identity.IdentifiedResource, fallback: string): string => {
  const birthDate = resource.resourceType === 'Patient' ? resource.birthDate : null
  const parts = [
    ...Option.toArray(firstNameOf(resource)),
    ...(birthDate === null ? [] : [birthDate]),
  ]
  return parts.length === 0 ? fallback : parts.join(' · ')
}

/** The resource-backed row for one decoded resource, or `None` if it is not a row. */
const resourceBackedOf = (entry: DecodedFile.Resource): Option.Option<ResourceBacked> => {
  const { resource } = entry
  if (!Identity.isIdentifiedResource(resource)) return Option.none()
  return Option.map(Identity.ofResource(resource), (identity): ResourceBacked => ({
    _tag: 'resource',
    identity,
    identifiers: Array.dedupeWith(
      [...resource.identifier, ...Option.toArray(derivedIdentifier(resource))].filter(
        Identity.isLinkable
      ),
      IdentifierAndReference.identifierEquivalence
    ),
    resource,
    reviewKey: entry.key,
    label: labelOf(resource, identity.value),
  }))
}

/** The id-only rows one decoded resource's identifier-only references name. */
const idOnlyOf = (entry: DecodedFile.Resource): readonly IdOnly[] =>
  ResourceReferences.collect(entry.resource).flatMap((reference) =>
    pipe(
      ReferenceSlot.identityOf(entry.resource, reference),
      Option.map((identity): IdOnly => ({ _tag: 'reference', identity, label: identity.value })),
      Option.toArray
    )
  )

/**
 * Every row a decoded file holds, once per identity: the resource-backed rows
 * in review order, then the id-only rows in the order their references are
 * first seen.
 *
 * @remarks
 * A resource with no linkable `identifier[0]` is not a row; the stage writes
 * it as it is. An identifier-only reference to an identity a resource-backed
 * row already holds is that row, not a second one.
 */
const discover = (decodedFile: Pick<DecodedFile.DecodedFile, 'sections'>): readonly Type[] => {
  const entries = DecodedFile.resources(decodedFile)
  const rows: readonly Type[] = [
    ...entries.flatMap((entry) => Option.toArray(resourceBackedOf(entry))),
    ...entries.flatMap(idOnlyOf),
  ]
  return Array.dedupeWith(rows, (left, right) =>
    Identity.equivalence(left.identity, right.identity)
  )
}

export { derivedIdentifier, discover, key, labelOf }
export type { IdOnly, ResourceBacked, Type }
