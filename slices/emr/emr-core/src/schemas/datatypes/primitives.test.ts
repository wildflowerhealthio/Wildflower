import { Arbitrary, DateTime, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { IdSchema, InstantSchema, TimeSchema, UriSchema } from './primitives.ts'

// ---------------------------------------------------------------------------
// time — hh:mm:ss with optional fractional seconds
// ---------------------------------------------------------------------------

describe('TimeSchema', () => {
  const decode = Schema.decodeUnknownEither(TimeSchema)

  describe('accepts spec-compliant times', () => {
    test.each([
      ['00:00:00', 'midnight'],
      ['23:59:59', 'last second of day'],
      ['23:59:60', 'leap second'],
      ['12:30:45', 'mid-day'],
      ['12:30:45.1', 'one fractional digit'],
      ['12:30:45.123', 'three fractional digits'],
      ['12:30:45.123456789', 'nine fractional digits'],
    ])('%s — %s', (value) => {
      expect(decode(value)._tag).toBe('Right')
    })
  })

  describe('rejects malformed times', () => {
    test.each([
      ['24:00:00', 'hour out of range'],
      ['12:60:00', 'minute out of range'],
      ['12:30:61', 'second above leap-second tolerance'],
      ['1:30:00', 'missing leading zero on hour'],
      ['12:3:00', 'missing leading zero on minute'],
      ['12:30:00.', 'trailing dot with no fraction'],
      ['12:30:00.1234567890', 'ten fractional digits'],
      ['', 'empty string'],
      ['noon', 'non-numeric'],
      ['12:30', 'missing seconds'],
    ])('%s — %s', (value) => {
      expect(decode(value)._tag).toBe('Left')
    })
  })

  test('property: arbitrary instances always decode', () => {
    const arb = Arbitrary.make(TimeSchema)
    fc.assert(
      fc.property(arb, (value) => {
        expect(decode(value)._tag).toBe('Right')
      }),
      { numRuns: numRunsFor(100) }
    )
  })

  test('property: encode/decode round-trip preserves value', () => {
    const arb = Arbitrary.make(TimeSchema)
    const encode = Schema.encodeSync(TimeSchema)
    const decodeSync = Schema.decodeSync(TimeSchema)
    fc.assert(
      fc.property(arb, (value) => {
        expect(decodeSync(encode(value))).toBe(value)
      }),
      { numRuns: numRunsFor(100) }
    )
  })
})

// ---------------------------------------------------------------------------
// uri / url / canonical — non-whitespace string
// ---------------------------------------------------------------------------

describe('UriSchema', () => {
  const decode = Schema.decodeUnknownEither(UriSchema)

  describe('accepts non-whitespace strings', () => {
    test.each([
      ['', 'empty string (FHIR allows it)'],
      ['http://example.com', 'http url'],
      ['https://example.com/path?q=1#frag', 'url with query and fragment'],
      ['urn:oid:1.2.3.4', 'URN'],
      ['Patient/123', 'relative reference'],
      ['#contained', 'fragment-only'],
      ['file:///tmp/x.json', 'file scheme'],
      ['data:,Hello', 'data URI'],
    ])('%s — %s', (value) => {
      expect(decode(value)._tag).toBe('Right')
    })
  })

  describe('rejects strings containing whitespace', () => {
    test.each([
      ['http://example.com/has space', 'space in path'],
      [' leading-space', 'leading space'],
      ['trailing-space ', 'trailing space'],
      ['line\nbreak', 'newline'],
      ['tab\there', 'tab'],
    ])('%s — %s', (value) => {
      expect(decode(value)._tag).toBe('Left')
    })
  })

  test('property: arbitrary instances always decode', () => {
    const arb = Arbitrary.make(UriSchema)
    fc.assert(
      fc.property(arb, (value) => {
        expect(decode(value)._tag).toBe('Right')
      }),
      { numRuns: numRunsFor(100) }
    )
  })

  test('property: encode/decode round-trip preserves value', () => {
    const arb = Arbitrary.make(UriSchema)
    const encode = Schema.encodeSync(UriSchema)
    const decodeSync = Schema.decodeSync(UriSchema)
    fc.assert(
      fc.property(arb, (value) => {
        expect(decodeSync(encode(value))).toBe(value)
      }),
      { numRuns: numRunsFor(100) }
    )
  })
})

// ---------------------------------------------------------------------------
// id — 1-64 chars of [A-Za-z0-9-.]
// ---------------------------------------------------------------------------

describe('IdSchema', () => {
  const decode = Schema.decodeUnknownEither(IdSchema)

  describe('accepts spec-compliant ids', () => {
    test.each([
      ['a', 'single letter'],
      ['1', 'single digit'],
      ['patient-001', 'with dash'],
      ['v1.2.3', 'with dots'],
      ['ABC-123.xyz', 'mixed case with dash and dot'],
      ['a'.repeat(64), '64 chars (max)'],
    ])('%s — %s', (value) => {
      expect(decode(value)._tag).toBe('Right')
    })
  })

  describe('rejects malformed ids', () => {
    test.each([
      ['', 'empty string'],
      ['a'.repeat(65), '65 chars (over max)'],
      ['has space', 'whitespace'],
      ['has_underscore', 'underscore not allowed'],
      ['has/slash', 'slash not allowed'],
      ['café', 'non-ASCII letter'],
      ['#hash', 'hash not allowed'],
    ])('%s — %s', (value) => {
      expect(decode(value)._tag).toBe('Left')
    })
  })

  test('property: arbitrary instances always decode', () => {
    const arb = Arbitrary.make(IdSchema)
    fc.assert(
      fc.property(arb, (value) => {
        expect(decode(value)._tag).toBe('Right')
      }),
      { numRuns: numRunsFor(100) }
    )
  })

  test('property: encode/decode round-trip preserves value', () => {
    const arb = Arbitrary.make(IdSchema)
    const encode = Schema.encodeSync(IdSchema)
    const decodeSync = Schema.decodeSync(IdSchema)
    fc.assert(
      fc.property(arb, (value) => {
        expect(decodeSync(encode(value))).toBe(value)
      }),
      { numRuns: numRunsFor(100) }
    )
  })
})

// ---------------------------------------------------------------------------
// instant — FHIR R4 `instant`, an ISO 8601 UTC timestamp with mandatory tz
// offset and at-least-second precision. Today the schema is the unconstrained
// `Schema.DateTimeUtc`; the spec-derived regex below guards the public
// contract so a future tightening (or laxening) of `InstantSchema` shows up
// as a test diff rather than a silent behavior change downstream.
// ---------------------------------------------------------------------------

// From https://build.fhir.org/datatypes.html#instant — the spec regex,
// transcribed verbatim and anchored. Note `[1-9]000` is the lower-bound
// year, so years < 1000 are rejected by the spec.
const FHIR_INSTANT_REGEX =
  /^([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)-(0[1-9]|1[0-2])-(0[1-9]|[1-2][0-9]|3[0-1])T([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\.[0-9]{1,9})?(Z|(\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00))$/

describe('InstantSchema', () => {
  const decode = Schema.decodeUnknownEither(InstantSchema)
  const encode = Schema.encodeSync(InstantSchema)
  const decodeSync = Schema.decodeSync(InstantSchema)

  test('round-trip of a canonical UTC string', () => {
    const canonical = '2015-02-07T13:28:17.239Z'
    const decoded = decodeSync(canonical)
    expect(DateTime.formatIso(decoded)).toBe(canonical)
    // Encoded form is always normalised to UTC `Z`.
    expect(encode(decoded)).toBe(canonical)
  })

  test('property: arbitrary encoded values match the FHIR instant regex', () => {
    const arb = Arbitrary.make(InstantSchema)
    fc.assert(
      fc.property(arb, (value) => {
        expect(encode(value)).toMatch(FHIR_INSTANT_REGEX)
      }),
      { numRuns: numRunsFor(100) }
    )
  })

  test('property: encode/decode round-trip preserves value', () => {
    const arb = Arbitrary.make(InstantSchema)
    fc.assert(
      fc.property(arb, (value) => {
        expect(DateTime.toEpochMillis(decodeSync(encode(value)))).toBe(
          DateTime.toEpochMillis(value)
        )
      }),
      { numRuns: numRunsFor(100) }
    )
  })

  describe('accepts FHIR-spec instant strings', () => {
    test.each([
      ['2015-02-07T13:28:17.239+02:00', 'spec example with positive offset'],
      ['2017-01-01T00:00:00Z', 'spec example, UTC Z, no fraction'],
      ['1970-01-01T00:00:00.000Z', 'unix epoch with millis'],
      ['2026-12-31T23:59:59-14:00', 'maximum negative offset'],
    ])('%s — %s', (value) => {
      expect(decode(value)._tag).toBe('Right')
    })
  })
})
