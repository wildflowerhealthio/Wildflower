import { DateTime } from 'effect'
import * as fc from 'fast-check'

/**
 * An as-of instant anywhere in 2000–2099, at any time of day: the range a
 * data set is plausibly dated from, wide enough to cross leap years and
 * century-free February 29ths.
 */
const asOfArbitrary: fc.Arbitrary<DateTime.Utc> = fc
  .integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2099, 11, 31) })
  .map((epochMillis) => DateTime.unsafeMake(epochMillis))

export { asOfArbitrary }
