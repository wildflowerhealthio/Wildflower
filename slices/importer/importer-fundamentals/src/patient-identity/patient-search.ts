/**
 * The one server read patient identity needs: the person a source Patient's
 * identifiers already name, if the store holds one.
 *
 * @packageDocumentation
 */

import {
  FhirR4ResourcesHttpApiClient,
  type FhirR4ResourcesHttpApiClientShape,
} from '@wildflowerhealthio/fhir-r4/clients'
import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type { Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { Effect, Option } from 'effect'

import type * as Person from './person.ts'

/** What a `Patient` search can fail with: the typed client's own failures. */
type SearchFailure = Effect.Effect.Error<
  ReturnType<FhirR4ResourcesHttpApiClientShape['Patient']['SearchByGet']>
>

/** An identifier with both halves of a `system|value` search token. */
type SearchedIdentifier = IdentifierAndReference.IdentifierType & {
  readonly system: URL
  readonly value: string
}

const isSearchable = (
  identifier: IdentifierAndReference.IdentifierType
): identifier is SearchedIdentifier => identifier.system !== null && identifier.value !== null

/**
 * The identifiers a search for `sourcePatient`'s person tries, in order: each
 * one with both a `system` and a `value`.
 *
 * @remarks
 * A bare value with no system could match any system's identifier, so it is
 * not searched.
 */
const searchedIdentifiers = (sourcePatient: Patient.Type): readonly SearchedIdentifier[] =>
  sourcePatient.identifier.filter(isSearchable)

/**
 * One half of a `token` search value with FHIR search's special characters
 * escaped, so a `,` (or) or `|` (system separator) inside it is read literally.
 */
const escapeSearchValue = (raw: string): string => raw.replaceAll(/[\\,$|]/gu, '\\$&')

/** An identifier as a FHIR `token` search value, `system|value`. */
const searchTokenOf = (identifier: SearchedIdentifier): string =>
  `${escapeSearchValue(identifier.system.href)}|${escapeSearchValue(identifier.value)}`

/**
 * The stored Patient one of `sourcePatient`'s identifiers names, searched
 * `GET Patient?identifier=system|value` one identifier at a time.
 *
 * @param sourcePatient - A source Patient the import decoded
 * @returns The first Patient found, or `None` when no identifier names one
 *
 * @remarks
 * The identifiers are tried in `sourcePatient`'s own order
 * ({@link searchedIdentifiers}), so the source's adopted id
 * (`identifier[0]`) goes first, and the first that finds a Patient wins; the
 * rest are not searched. A failed search fails the whole read rather than
 * reading as "no match".
 */
const findPatientByIdentifier = (
  sourcePatient: Patient.Type
): Effect.Effect<Option.Option<Person.Type>, SearchFailure, FhirR4ResourcesHttpApiClient> =>
  Effect.gen(function* () {
    const client = yield* FhirR4ResourcesHttpApiClient
    for (const identifier of searchedIdentifiers(sourcePatient)) {
      const bundle = yield* client.Patient.SearchByGet({
        urlParams: { identifier: searchTokenOf(identifier) },
      })
      const person = bundle.entry.find((entry) => entry.resource !== null)?.resource
      if (person != null) return Option.some(person)
    }
    return Option.none()
  })

export { findPatientByIdentifier, searchedIdentifiers }
export type { SearchedIdentifier }
