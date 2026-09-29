import type { Person } from '../person.ts'

/**
 * The Ashford family's demographics — three generations, named for their
 * stories: **War**ren (warfarin), **Ty**ra (thyroid), **Beau** **Hart**man
 * (beta blocker, heart) and **Fe**rn (iron).
 *
 * @remarks
 * Warren is Tyra's father; Beau is Tyra's spouse; Fern is their daughter. Every
 * name, address and account is fictional; emails use the reserved
 * `example.com` domain.
 */

const warren: Person = {
  key: 'warren',
  givenName: 'Warren',
  familyName: 'Ashford',
  gender: 'male',
  age: 78,
  daysSinceBirthday: 143,
  email: 'warren.ashford@example.com',
  postalCode: 'K7L 2V4',
}

const tyra: Person = {
  key: 'tyra',
  givenName: 'Tyra',
  familyName: 'Ashford',
  gender: 'female',
  age: 46,
  daysSinceBirthday: 57,
  email: 'tyra.ashford@example.com',
  postalCode: 'K7M 5B1',
}

const beau: Person = {
  key: 'beau',
  givenName: 'Beau',
  familyName: 'Hartman',
  gender: 'male',
  age: 48,
  daysSinceBirthday: 301,
  email: 'beau.hartman@example.com',
  postalCode: 'K7M 5B1',
}

const fern: Person = {
  key: 'fern',
  givenName: 'Fern',
  familyName: 'Ashford',
  gender: 'female',
  age: 16,
  daysSinceBirthday: 212,
  email: 'fern.ashford@example.com',
  postalCode: 'K7M 5B1',
}

/** The family, eldest first. */
const people: readonly Person[] = [warren, tyra, beau, fern]

export { beau, fern, people, tyra, warren }
