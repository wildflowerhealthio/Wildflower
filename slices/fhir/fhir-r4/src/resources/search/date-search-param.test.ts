import { Arbitrary, DateTime, Either, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as DateSearchParam from './date-search-param.ts'

const decode = Schema.decodeUnknownSync(DateSearchParam.Schema)
const encode = Schema.encodeSync(DateSearchParam.Schema)
const decodeEither = Schema.decodeUnknownEither(DateSearchParam.Schema)

const instant = (iso: string): DateTime.Utc => DateTime.unsafeMake(iso)

describe('DateSearchParam', () => {
  it.each([
    {
      precision: 'year',
      wire: '2026',
      lowerBound: '2026-01-01T00:00:00.000Z',
      upperBound: '2026-12-31T23:59:59.999Z',
    },
    {
      precision: 'year-month',
      wire: '2026-07',
      lowerBound: '2026-07-01T00:00:00.000Z',
      upperBound: '2026-07-31T23:59:59.999Z',
    },
    {
      precision: 'day',
      wire: '2026-07-27',
      lowerBound: '2026-07-27T00:00:00.000Z',
      upperBound: '2026-07-27T23:59:59.999Z',
    },
    {
      precision: 'hour-minute',
      wire: '2026-07-27T14:27Z',
      lowerBound: '2026-07-27T14:27:00.000Z',
      upperBound: '2026-07-27T14:27:59.999Z',
    },
    {
      precision: 'second',
      wire: '2026-07-27T14:27:30Z',
      lowerBound: '2026-07-27T14:27:30.000Z',
      upperBound: '2026-07-27T14:27:30.999Z',
    },
    {
      precision: 'millisecond',
      wire: '2026-07-27T14:27:30.500Z',
      lowerBound: '2026-07-27T14:27:30.500Z',
      upperBound: '2026-07-27T14:27:30.500Z',
    },
  ])(
    'should bound a bare $precision value by the period its precision implies',
    ({ wire, lowerBound, upperBound }) => {
      // Act
      const decoded = decode(wire)

      // Assert — the absent prefix stays absent (the spec reads it as `eq`),
      // and the literal is kept verbatim so no precision is invented.
      expect(decoded).toSchemaEqual(DateSearchParam.Schema, {
        prefix: Option.none(),
        value: wire,
        lowerBound: instant(lowerBound),
        upperBound: instant(upperBound),
      })
    }
  )

  it.each(['eq', 'ne', 'gt', 'lt', 'ge', 'le', 'sa', 'eb', 'ap'] as const)(
    'should accept the "%s" prefix at any precision',
    (prefix) => {
      // Act
      const decoded = decode(`${prefix}2026`)

      // Assert — the spec places no precision constraint on prefixes; `ge2026`
      // means "on or after the start of 2026".
      expect(decoded).toSchemaEqual(DateSearchParam.Schema, {
        prefix: Option.some(prefix),
        value: '2026',
        lowerBound: instant('2026-01-01T00:00:00.000Z'),
        upperBound: instant('2026-12-31T23:59:59.999Z'),
      })
      expect(encode(decoded)).toBe(`${prefix}2026`)
    }
  )

  it.each([
    { reason: 'a common year', wire: '2026-02', lastInstant: '2026-02-28T23:59:59.999Z' },
    { reason: 'a leap year', wire: '2024-02', lastInstant: '2024-02-29T23:59:59.999Z' },
    { reason: 'a century common year', wire: '1900-02', lastInstant: '1900-02-28T23:59:59.999Z' },
    { reason: 'a century leap year', wire: '2000-02', lastInstant: '2000-02-29T23:59:59.999Z' },
  ])('should end February in $reason on its real last day', ({ wire, lastInstant }) => {
    // Act
    const decoded = decode(wire)

    // Assert
    expect(decoded).toSchemaEqual(DateSearchParam.Schema, {
      prefix: Option.none(),
      value: wire,
      lowerBound: instant(`${wire}-01T00:00:00.000Z`),
      upperBound: instant(lastInstant),
    })
  })

  it('should resolve a non-UTC offset into the bounds', () => {
    // Act
    const decoded = decode('ge2026-07-27T14:27+05:00')

    // Assert — the period is the same wall-clock minute, expressed in UTC.
    expect(decoded).toSchemaEqual(DateSearchParam.Schema, {
      prefix: Option.some('ge' as const),
      value: '2026-07-27T14:27+05:00',
      lowerBound: instant('2026-07-27T09:27:00.000Z'),
      upperBound: instant('2026-07-27T09:27:59.999Z'),
    })
  })

  it('should collapse a leap second onto the last instant of its minute', () => {
    // Act — POSIX time cannot represent :60, but FHIR's grammar admits it.
    const decoded = decode('2026-06-30T23:59:60Z')

    // Assert
    expect(decoded).toSchemaEqual(DateSearchParam.Schema, {
      prefix: Option.none(),
      value: '2026-06-30T23:59:60Z',
      lowerBound: instant('2026-06-30T23:59:59.999Z'),
      upperBound: instant('2026-06-30T23:59:59.999Z'),
    })
  })

  it.each([
    { reason: 'a prefix with no value', wire: 'eq' },
    { reason: 'an impossible month', wire: '2026-13' },
    { reason: 'an impossible day', wire: '2026-07-45' },
    { reason: 'a zero day', wire: '2026-07-00' },
    { reason: 'a zero month', wire: '2026-00' },
    { reason: 'the zero year', wire: '0000' },
    { reason: 'a timezone-less time', wire: 'ge2026-07-27T14:27:30' },
    { reason: 'an hour with no minutes', wire: '2026-07-27T14Z' },
    { reason: 'a non-date string', wire: 'yesterday' },
  ])('should reject $reason', ({ wire }) => {
    // Act
    const result = decodeEither(wire)

    // Assert
    expect(Either.isLeft(result)).toBe(true)
  })

  it.each(['2026-07', 'ge2026-07', '2026-07-27T14:27+05:00'])(
    'should re-emit "%s" exactly as it arrived',
    (wire) => {
      // Assert — the caller's spelling reaches the server unchanged; an absent
      // prefix is never materialized into the `eq` the spec implies.
      expect(encode(decode(wire))).toBe(wire)
    }
  )

  it('should round-trip any value through the wire', () => {
    fc.assert(
      fc.property(Arbitrary.make(DateSearchParam.Schema), (value) => {
        // Act
        const roundTripped = decode(encode(value))

        // Assert
        expect(roundTripped).toSchemaEqual(DateSearchParam.Schema, value)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should keep the lower bound at or before the upper bound', () => {
    fc.assert(
      fc.property(Arbitrary.make(DateSearchParam.Schema), ({ lowerBound, upperBound }) => {
        // Assert
        expect(DateTime.lessThanOrEqualTo(lowerBound, upperBound)).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
