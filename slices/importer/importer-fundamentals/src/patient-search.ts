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
import type { Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { Effect, Option } from 'effect'

import * as PatientIdentity from './patient-identity.ts'

/** What a `Patient` search can fail with: the typed client's own failures. */
type SearchFailure = Effect.Effect.Error<
  ReturnType<FhirR4ResourcesHttpApiClientShape['Patient']['SearchByGet']>
>

/**
 * One half of a `token` search value with FHIR search's special characters
 * escaped, so a `,` (or) or `|` (system separator) inside it is read literally.
 */
const escapeSearchValue = (raw: string): string => raw.replaceAll(/[\\,$|]/gu, '\\$&')

/** An identifier as a FHIR `token` search value, `system|value`. */
const searchTokenOf = (identifier: PatientIdentity.SearchedIdentifier): string =>
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
 * ({@link PatientIdentity.searchedIdentifiers}), so the source's adopted id
 * (`identifier[0]`) goes first, and the first that finds a Patient wins; the
 * rest are not searched. A household account searches nothing, so it is never
 * matched into a person. A failed search fails the whole read rather than
 * reading as "no match".
 */
const findPatientByIdentifier = (
  sourcePatient: Patient.Type
): Effect.Effect<
  Option.Option<PatientIdentity.Person>,
  SearchFailure,
  FhirR4ResourcesHttpApiClient
> =>
  Effect.gen(function* () {
    const client = yield* FhirR4ResourcesHttpApiClient
    for (const identifier of PatientIdentity.searchedIdentifiers(sourcePatient)) {
      const bundle = yield* client.Patient.SearchByGet({
        urlParams: { identifier: searchTokenOf(identifier) },
      })
      const person = bundle.entry.find((entry) => entry.resource !== null)?.resource
      if (person != null) return Option.some(person)
    }
    return Option.none()
  })

export { findPatientByIdentifier }
