import type { Arbitrary, FastCheck } from 'effect'
import { DateTime, Schema, pipe } from 'effect'

// ---------------------------------------------------------------------------
// Strict primitive schemas
// ---------------------------------------------------------------------------

// `Schema.pattern`'s built-in `Arbitrary.make(...)` walks the regex via
// `fc.stringMatching`, which is correct but slow enough to dominate runtime
// when these primitives feed the value[x] choice for property tests over
// resources (each property run touches dozens of choice fields). The
// per-schema `arbitrary` annotations below keep generation fast while still
// emitting representational valid values across the spec ranges.

/** FHIR R4 `time`: `hh:mm:ss[.fff]` with leap-second tolerance. */
const TimeSchema = Schema.String.pipe(
  Schema.pattern(/^([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\.[0-9]{1,9})?$/),
  Schema.annotations({
    arbitrary: (): Arbitrary.LazyArbitrary<string> => (fc: typeof FastCheck) =>
      fc.constantFrom(
        '00:00:00',
        '23:59:59',
        '23:59:60',
        '12:30:45',
        '12:30:45.1',
        '12:30:45.123',
        '12:30:45.123456789',
        '06:15:30',
        '18:45:00.5'
      ),
  })
)

/** FHIR R4 `uri`/`url`/`canonical`: any non-whitespace string per spec regex. */
const UriSchema = Schema.String.pipe(
  Schema.pattern(/^\S*$/),
  Schema.annotations({
    arbitrary: (): Arbitrary.LazyArbitrary<string> => (fc: typeof FastCheck) =>
      fc.constantFrom(
        '',
        'http://example.com',
        'https://example.com/path?q=1#frag',
        'urn:oid:1.2.3.4',
        'Patient/123',
        '#contained',
        'data:,Hello'
      ),
  })
)

// The FHIR R4 `date` regex, anchored. Unrefined so `DateSchema`'s arbitrary
// can brand its generated literals through a decode instead of a cast.
const DateBaseSchema = Schema.String.pipe(
  Schema.pattern(
    /^([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)(-(0[1-9]|1[0-2])(-(0[1-9]|[1-2][0-9]|3[0-1]))?)?$/
  ),
  Schema.brand('FhirDate')
)

/**
 * FHIR R4 `date`: `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`, with no time or zone.
 * Decoded as the wire string itself (branded `FhirDate`), so a partial date
 * keeps its precision and re-encodes byte for byte.
 *
 * @remarks
 * The pattern is the spec's; like the spec regex it does not check that a day
 * exists in its month (`2026-02-31` passes).
 */
const DateSchema = DateBaseSchema.annotations({
  arbitrary: (): Arbitrary.LazyArbitrary<typeof DateBaseSchema.Type> => (fc: typeof FastCheck) =>
    fc
      .tuple(
        fc.integer({ min: 1, max: 9999 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        // How many of year / month / day the literal carries.
        fc.integer({ min: 1, max: 3 })
      )
      .map(([year, month, day, precision]) =>
        Schema.decodeSync(DateBaseSchema)(
          [
            String(year).padStart(4, '0'),
            String(month).padStart(2, '0'),
            String(day).padStart(2, '0'),
          ]
            .slice(0, precision)
            .join('-')
        )
      ),
})

/** FHIR R4 `id`: 1-64 chars of `[A-Za-z0-9\-.]`. */
const IdSchema = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9\-.]{1,64}$/),
  Schema.annotations({
    arbitrary: (): Arbitrary.LazyArbitrary<string> => (fc: typeof FastCheck) =>
      fc.constantFrom('a', '1', 'patient-001', 'v1.2.3', 'ABC-123.xyz', 'abc.def-123'),
  })
)

/** FHIR R4 `instant`: precise UTC datetime, always with timezone, at least
 * seconds precision. Decoded shape is `DateTime.Utc` so it shares the
 * Effect-side representation of `dateTime`.
 *
 * Note: the schema itself is `Schema.DateTimeUtc`, which accepts any ISO 8601
 * UTC datetime. A future tightening would add a refinement on the encoded
 * side enforcing the FHIR `instant` regex (year 1000–9999, mandatory tz
 * offset, at-least-second precision). The arbitrary annotation below already
 * stays inside the FHIR-valid range so property tests over schemas that
 * embed `InstantSchema` exercise spec-conformant values. */
const InstantSchema = pipe(
  Schema.DateTimeUtc,
  Schema.annotations({
    arbitrary:
      (): Arbitrary.LazyArbitrary<DateTime.Utc> =>
      (fc: typeof FastCheck): FastCheck.Arbitrary<DateTime.Utc> =>
        // FHIR `instant` regex bounds years to [1000, 9999]. Sample epoch-ms
        // within that window so `DateTime.formatIso` always emits a
        // FHIR-valid string. 0001-01-01T00:00:00Z → -62135596800000;
        // 9999-12-31T23:59:59.999Z → 253402300799999; clamp to
        // [1000-01-01, 9999-12-31].
        fc
          .integer({ min: -30610224000000, max: 253402300799999 })
          .map((ms) => DateTime.unsafeMake(ms)),
  })
)

export { DateSchema, IdSchema, InstantSchema, TimeSchema, UriSchema }
