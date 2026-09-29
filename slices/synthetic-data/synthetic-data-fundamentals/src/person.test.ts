import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Person from './person.ts'
import { ageOn, asOfArbitrary, personArbitrary } from './test-helpers.ts'

const personArb = personArbitrary('someone')

describe('Person.birthDateOf', () => {
  test('property: the person is `age` on the as-of day', () => {
    fc.assert(
      fc.property(personArb, asOfArbitrary, (person, asOf) => {
        expect(ageOn(Person.birthDateOf(person, asOf), asOf)).toBe(person.age)
      }),
      { numRuns: numRunsFor({ base: 300 }) }
    )
  })

  test('property: depends only on the as-of calendar day', () => {
    fc.assert(
      fc.property(
        personArb,
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
