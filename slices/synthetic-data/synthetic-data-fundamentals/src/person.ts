import { DateTime } from 'effect'
import type { AdministrativeGender } from 'fhir-r4/data-types'

import * as StoryDay from './story-day.ts'

/**
 * One person in a synthetic data set, with the demographics every source
 * renders: name, administrative gender, and an age that holds at any as-of
 * date.
 */

/**
 * A person's demographics, dated from the as-of date like everything else.
 *
 * @remarks
 * The birth date is not stored: `age` and `daysSinceBirthday` pin it relative
 * to the as-of day ({@link birthDateOf}), so the person is the same age in
 * every regenerated data set. That is why this is a story's own model rather
 * than a FHIR `Patient`: a source renders the resource, or its own profile
 * shape, from it on a given as-of date.
 *
 * The name is the two parts every source writes (a carebook profile's
 * `firstName` / `lastName`, a FHIR `HumanName`'s `given` / `family`), not a
 * `HumanName`: one name, never several with uses and periods, is all a
 * generated person has.
 */
interface Person {
  /** Stable lower-case handle every derived id is hashed from (`'person-1'`). */
  readonly key: string
  readonly givenName: string
  readonly familyName: string
  readonly gender: AdministrativeGender
  /** Age in whole years on the as-of day. */
  readonly age: number
  /** Days from the most recent birthday to the as-of day, in `[0, 364]`. */
  readonly daysSinceBirthday: number
  /** A fictional address at the reserved `example.com` domain. */
  readonly email: string
  /** Canadian postal code (`A1A 1A1`). */
  readonly postalCode: string
}

/**
 * The person's birth date: `age` years and `daysSinceBirthday` days before the
 * as-of day.
 *
 * @remarks
 * The most recent birthday is found first (`daysSinceBirthday` before the as-of
 * day), then `age` calendar years are subtracted from it. A last birthday on
 * February 29 lands on February 28 of a non-leap birth year, as
 * `DateTime.subtract` clamps it; the age on the as-of day is `age` either way.
 */
const birthDateOf = (person: Person, asOf: DateTime.Utc): DateTime.Utc => {
  const lastBirthday = DateTime.subtract(StoryDay.asOfDayOf(asOf), {
    days: person.daysSinceBirthday,
  })
  return DateTime.subtract(lastBirthday, { years: person.age })
}

/** The person's full name, given name first (`'Sam Okoye'`). */
const fullNameOf = (person: Person): string => `${person.givenName} ${person.familyName}`

export { birthDateOf, fullNameOf }
export type { Person }
