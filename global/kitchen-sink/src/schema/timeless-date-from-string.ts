import type { Arbitrary, FastCheck } from 'effect'
import { Predicate, Schema } from 'effect'

/**
 * An Effect Schema for a `YYYY-MM-DD` date string. Validates the format
 * via regex and verifies the date is a real calendar date. Does not
 * transform to a `Date` object. Designed for timezone-independent dates
 * (e.g. birthdays) where the time component is meaningless.
 *
 * The decoded type is a branded string (`string & Brand<"TimelessDate">`),
 * not a plain string, so it cannot be confused with arbitrary strings.
 *
 * Includes custom arbitraries constrained to years 1900–2100.
 */
export const TimelessDateFromString = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.filter((value) => {
    const date = new Date(value + 'T00:00:00Z')
    if (Number.isNaN(date.getTime())) {
      return 'Expected a valid calendar date'
    }
    // Verify the parsed date components match the input to catch impossible dates
    // like 2024-02-30 (which Date would silently roll forward to 2024-03-01)
    const parts = value.split('-').map(Number)
    if (!Predicate.isTupleOfAtLeast(parts, 3)) {
      return 'Expected a valid calendar date'
    }
    const [year, month, day] = parts
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() + 1 !== month ||
      date.getUTCDate() !== day
    ) {
      return 'Expected a valid calendar date'
    }
    return undefined
  }),
  Schema.annotations({
    arbitrary: (): Arbitrary.LazyArbitrary<string> => (fc: typeof FastCheck) =>
      fc
        .date()
        .filter((date) => date.getFullYear() >= 1900 && date.getFullYear() <= 2100)
        .map((date) => date.toISOString().slice(0, 10)),
  }),
  Schema.brand('TimelessDate')
)

/** The branded type for a validated `YYYY-MM-DD` date string. */
export type TimelessDate = typeof TimelessDateFromString.Type
