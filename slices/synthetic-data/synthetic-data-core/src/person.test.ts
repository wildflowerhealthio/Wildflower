import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { asOfArbitrary } from './arbitraries.test-helpers.ts'
import * as Person from './person.ts'

/** Whole years from `birth` to `on`, as a birthday count: the test's own reckoning. */
const ageOn = (birth: DateTime.Utc, on: DateTime.Utc): number => {
  const birthParts = DateTime.toPartsUtc(birth)
  const onParts = DateTime.toPartsUtc(on)
  const birthdayReached =
    onParts.month > birthParts.month ||
    (onParts.month === birthParts.month && onParts.day >= birthParts.day)
  return onParts.year - birthParts.year - (birthdayReached ? 0 : 1)
}

const personArbitrary: fc.Arbitrary<Person.Person> = fc.record({
  key: fc.constant('someone'),
  givenName: fc.constant('Some'),
  familyName: fc.constant('One'),
  gender: fc.constantFrom('male', 'female'),
  age: fc.integer({ min: 0, max: 110 }),
  daysSinceBirthday: fc.integer({ min: 0, max: 364 }),
  email: fc.constant('some.one@example.com'),
  postalCode: fc.constant('K7L 2V4'),
})

describe('Person.birthDateOf', () => {
  test('property: the person is `age` on the as-of day', () => {
    fc.assert(
      fc.property(personArbitrary, asOfArbitrary, (person, asOf) => {
        expect(ageOn(Person.birthDateOf(person, asOf), asOf)).toBe(person.age)
      }),
      { numRuns: numRunsFor({ base: 300 }) }
    )
  })

  test('property: depends only on the as-of calendar day', () => {
    fc.assert(
      fc.property(
        personArbitrary,
        asOfArbitrary,
        fc.integer({ min: 0, max: 86_399_999 }),
        (person, asOf, millisIntoDay) => {
          const sameDay = DateTime.add(DateTime.startOf(asOf, 'day'), { millis: millisIntoDay })
          expect(Person.birthDateOf(person, sameDay)).toEqual(Person.birthDateOf(person, asOf))
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
