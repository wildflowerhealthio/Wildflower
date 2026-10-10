import {
  type StoryCase,
  storyCaseArbitrary,
} from '@wildflowerhealthio/synthetic-data-fundamentals/test-helpers'
/**
 * fast-check arbitraries for the Shoppers generator's inputs: a family account
 * whose managed people each have a story drawn from
 * `synthetic-data-fundamentals/test-helpers`, shared through the
 * `synthetic-data-shoppers-drugmart/test-helpers` subpath.
 *
 * @packageDocumentation
 */
import * as fc from 'fast-check'

import type { ShoppersAccount } from './shoppers-account.ts'

/** A generated family account, and each managed person's story case in portal order. */
interface ShoppersCase {
  readonly account: ShoppersAccount
  readonly patients: readonly StoryCase[]
}

/** A ten-digit phone number in the `555-01xx` range reserved for fiction. */
const phoneNumberOf = (areaCode: number, line: number): string =>
  `${areaCode}55501${String(line % 100).padStart(2, '0')}`

/**
 * A person's story case whose prescriptions each have their own last fill
 * day: the portal dates a prescription by its last fill, so a test can find
 * one by it.
 */
const patientStoryCaseArbitrary = (personKey: string): fc.Arbitrary<StoryCase> =>
  storyCaseArbitrary(personKey).filter(
    ({ expected }) =>
      new Set(expected.map(({ lastFillDay }) => lastFillDay)).size === expected.length
  )

/**
 * A Shoppers Drug Mart family account managing one to four people, the
 * account holder listed first, each with a generated story; every
 * prescription of theirs filled at one store.
 */
const shoppersCaseArbitrary: fc.Arbitrary<ShoppersCase> = fc
  .integer({ min: 1, max: 4 })
  .chain((count) =>
    fc.record({
      pcid: fc.uuid({ version: 4 }),
      patientIds: fc.uniqueArray(fc.uuid({ version: 4 }), {
        minLength: count,
        maxLength: count,
      }),
      holder: patientStoryCaseArbitrary('person-1'),
      others: fc.tuple(
        ...Array.from({ length: count - 1 }, (_, index) =>
          patientStoryCaseArbitrary(`person-${index + 2}`)
        )
      ),
      areaCode: fc.constantFrom(416, 519, 613, 705, 905),
      phoneLines: fc.array(fc.nat({ max: 99 }), { minLength: count + 2, maxLength: count + 2 }),
      store: fc.integer({ min: 100, max: 9999 }),
      streetNumber: fc.integer({ min: 1, max: 999 }),
    })
  )
  .map(({ pcid, patientIds, holder, others, areaCode, phoneLines, store, streetNumber }) => {
    const phoneOf = (index: number): string => phoneNumberOf(areaCode, phoneLines[index] ?? 0)
    const patientOf = (storyCase: StoryCase, index: number): ShoppersAccount['patients'][0] => ({
      patientId: patientIds[index] ?? pcid,
      phoneNumber: phoneOf(index + 2),
      story: storyCase.story,
    })
    return {
      patients: [holder, ...others],
      account: {
        pcid,
        phoneNumber: phoneOf(0),
        address: {
          line1: `${streetNumber} Main St`,
          city: 'Kingston',
          province: 'ON',
          postalCode: holder.story.person.postalCode,
        },
        store: {
          id: store,
          storeName: `Shoppers Drug Mart #${store}`,
          phoneNumber: phoneOf(1),
          address: {
            line1: `${streetNumber + 100} King St`,
            city: 'Kingston',
            province: 'ON',
            postalCode: 'K7L 1B3',
          },
        },
        patients: [
          patientOf(holder, 0),
          ...others.map((storyCase, index) => patientOf(storyCase, index + 1)),
        ],
      },
    }
  })

export { shoppersCaseArbitrary }
export type { ShoppersCase }
