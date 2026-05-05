import type { Arbitrary, FastCheck } from 'effect'
import { Schema } from 'effect'

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

/** FHIR R4 `id`: 1-64 chars of `[A-Za-z0-9\-.]`. */
const IdSchema = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9\-.]{1,64}$/),
  Schema.annotations({
    arbitrary: (): Arbitrary.LazyArbitrary<string> => (fc: typeof FastCheck) =>
      fc.constantFrom('a', '1', 'patient-001', 'v1.2.3', 'ABC-123.xyz', 'abc.def-123'),
  })
)

export { IdSchema, TimeSchema, UriSchema }
