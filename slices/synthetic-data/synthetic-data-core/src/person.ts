import { DateTime } from 'effect'

import * as StoryDay from './story-day.ts'

/**
 * One member of a synthetic family, with the demographics every source
 * renders: name, administrative gender, and an age that holds at any as-of
 * date.
 */

/** FHIR's administrative gender, as the sources write it. */
type Gender = 'male' | 'female'

/**
 * A person's demographics, dated from the as-of date like everything else.
 *
 * @remarks
 * The birth date is not stored: `age` and `daysSinceBirthday` pin it relative
 * to the as-of day ({@link birthDateOf}), so the person is the same age in
 * every regenerated data set.
 */
interface Person {
  /** Stable lower-case handle every derived id is hashed from (`'warren'`). */
  readonly key: string
  readonly givenName: string
  readonly familyName: string
  readonly gender: Gender
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

/** The person's full name, given name first (`'Warren Ashford'`). */
const fullNameOf = (person: Person): string => `${person.givenName} ${person.familyName}`

export { birthDateOf, fullNameOf }
export type { Gender, Person }
