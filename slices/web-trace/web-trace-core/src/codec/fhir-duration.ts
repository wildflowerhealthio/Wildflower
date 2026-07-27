import { Duration, ParseResult, Schema } from 'effect'
import { Duration as FhirDuration } from 'fhir-r4/data-types'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { UCUM_MILLISECOND_CODE, UCUM_SYSTEM } from './systems.ts'

/**
 * An Effect `Duration` carried as a FHIR R4 `Duration`.
 *
 * @packageDocumentation
 */

/**
 * The UCUM time codes that name a fixed span, and what one of each is worth.
 *
 * @remarks
 * `mo` and `a` (month, year) are deliberately absent: neither has a fixed
 * length, so neither converts to a `Duration` without inventing a calendar.
 * A trace timing is never expressed in months anyway — rejecting them is
 * better than picking an average.
 */
const UCUM_TIME_CODES: Readonly<Record<string, Duration.Duration>> = {
  ms: Duration.millis(1),
  s: Duration.seconds(1),
  min: Duration.minutes(1),
  h: Duration.hours(1),
  d: Duration.days(1),
  wk: Duration.weeks(1),
}

/**
 * A `Duration`, read from and written as a FHIR R4 `Duration` (a UCUM
 * `Quantity`).
 *
 * @remarks
 * Encoding always writes milliseconds — `{ value, unit: 'ms', system, code }`,
 * with `system`/`code` present because invariant `drt-1` requires a UCUM code
 * whenever there is a value.
 *
 * Decoding does **not** assume that. The `code` is what says what the number
 * means, so a duration written by anything else — a server, a later version of
 * this encoding, a hand-edited resource — is read in the unit it actually
 * states, and one stating a unit this cannot convert fails rather than being
 * quietly read as milliseconds. That failure mode is the whole reason this is a
 * schema and not a `.value` lookup.
 */
const DurationFromFhirDuration: Schema.Schema<Duration.Duration, FhirR4.Duration> =
  Schema.transformOrFail(FhirDuration.Schema, Schema.DurationFromSelf, {
    strict: true,
    decode: (quantity, _options, ast) => {
      const { value } = quantity
      const code = quantity.code?.toString()
      const system = quantity.system?.toString()
      if (value === null || value === undefined) {
        return ParseResult.fail(new ParseResult.Type(ast, quantity, 'Duration has no value'))
      }
      if (system !== undefined && system !== UCUM_SYSTEM) {
        return ParseResult.fail(
          new ParseResult.Type(ast, quantity, `Duration unit system is not UCUM: ${system}`)
        )
      }
      const unit = code === undefined ? undefined : UCUM_TIME_CODES[code]
      if (unit === undefined) {
        return ParseResult.fail(
          new ParseResult.Type(
            ast,
            quantity,
            `Duration has no convertible UCUM time code: ${code ?? '<absent>'}`
          )
        )
      }
      // Every supported code is a whole number of milliseconds, so scaling in
      // millis is exact for the fractional values a timing actually carries.
      return ParseResult.succeed(Duration.millis(value * Duration.toMillis(unit)))
    },
    encode: (duration) =>
      ParseResult.decodeUnknown(FhirDuration.Schema)({
        value: Duration.toMillis(duration),
        unit: UCUM_MILLISECOND_CODE,
        system: UCUM_SYSTEM,
        code: UCUM_MILLISECOND_CODE,
      }),
  }).annotations({
    identifier: 'DurationFromFhirDuration',
    description: 'An elapsed time, carried as a FHIR R4 Duration in UCUM units.',
  })

export { DurationFromFhirDuration, UCUM_TIME_CODES }
