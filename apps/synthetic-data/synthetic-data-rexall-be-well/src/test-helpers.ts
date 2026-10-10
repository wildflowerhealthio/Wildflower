/**
 * fast-check arbitraries for the Rexall generator's inputs beyond the story
 * (which `synthetic-data-fundamentals/test-helpers` draws), shared through the
 * `synthetic-data-rexall-be-well/test-helpers` subpath.
 *
 * @packageDocumentation
 */
import * as fc from 'fast-check'

import type { RexallAccount } from './rexall-account.ts'

/** A Rexall Be Well account, created and last updated before the as-of day. */
const rexallAccountArbitrary: fc.Arbitrary<RexallAccount> = fc
  .record({
    uid: fc.uuid({ version: 4 }),
    reportingGuid: fc.uuid({ version: 4 }),
    store: fc.integer({ min: 1000, max: 9999 }),
    createdDay: fc.integer({ min: -3000, max: -2 }),
    updatedDraw: fc.nat({ max: 3000 }),
  })
  .map(({ uid, reportingGuid, store, createdDay, updatedDraw }) => ({
    uid,
    reportingGuid,
    storeId: String(store),
    pharmacyLocationId: `pharmacy-${store}`,
    createdDay,
    updatedDay: createdDay + (updatedDraw % -createdDay),
  }))

export { rexallAccountArbitrary }
