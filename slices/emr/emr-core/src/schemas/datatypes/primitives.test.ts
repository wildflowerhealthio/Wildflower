import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { IdSchema, TimeSchema, UriSchema } from './primitives.ts'

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
      })
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
      })
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
      })
    )
  })
})
