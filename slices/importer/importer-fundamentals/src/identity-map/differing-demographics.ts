/**
 * Which demographics a decoded resource and the stored resource it is linked
 * to both state and differ: what a review warns about when a link may join two
 * different people. The link stands either way.
 *
 * @remarks
 * Name and birth date for a Patient, compared on `Patient.demographics` (each
 * record's current name, judged at the clock's now) so the review and the
 * identifier the demographics derive agree on what a name is. A Practitioner
 * has none the review compares, since its name is the identity.
 *
 * @packageDocumentation
 */

import { Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Effect, Option } from 'effect'

import type * as LinkableResource from './linkable-resource.ts'

/** One demographic a review compares two records of a person by. */
type Demographic = 'FamilyName' | 'GivenName' | 'BirthDate'

/** How each compared demographic is read off `Patient.demographics`, in the order a warning lists them. */
const COMPARED_PATIENT_DEMOGRAPHICS: ReadonlyArray<{
  readonly demographic: Demographic
  readonly read: (demographics: Patient.Demographics) => Option.Option<string>
}> = [
  { demographic: 'FamilyName', read: ({ family }) => family },
  { demographic: 'GivenName', read: ({ given }) => given },
  { demographic: 'BirthDate', read: ({ birthDate }) => birthDate },
]

/** Whether both `decoded` and `stored` state a value and the two differ. */
const bothStateAndDiffer = (
  decoded: Option.Option<string>,
  stored: Option.Option<string>
): boolean =>
  Option.all([decoded, stored]).pipe(
    Option.exists(([decodedValue, storedValue]) => decodedValue !== storedValue)
  )

/** The demographics two Patients both state that differ. */
const betweenPatients = (
  decoded: Patient.Type,
  stored: Patient.Type
): Effect.Effect<readonly Demographic[]> =>
  Effect.map(
    Effect.all([Patient.demographics(decoded), Patient.demographics(stored)]),
    ([decodedDemographics, storedDemographics]) =>
      Array.filterMap(COMPARED_PATIENT_DEMOGRAPHICS, ({ demographic, read }) =>
        bothStateAndDiffer(read(decodedDemographics), read(storedDemographics))
          ? Option.some(demographic)
          : Option.none()
      )
  )

/**
 * The demographics a link from `decoded` to `stored` is checked against that
 * differ, in the order a warning lists them; empty for a Practitioner.
 */
const between = (
  decoded: LinkableResource.WithId,
  stored: LinkableResource.WithId
): Effect.Effect<readonly Demographic[]> =>
  decoded.resourceType === 'Patient' && stored.resourceType === 'Patient'
    ? betweenPatients(decoded, stored)
    : Effect.succeed([])

export { between }
export type { Demographic }
