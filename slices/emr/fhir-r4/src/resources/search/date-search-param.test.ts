import { Arbitrary, DateTime, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as DateSearchParam from './date-search-param.ts'

const decode = Schema.decodeUnknownSync(DateSearchParam.Schema)
const encode = Schema.encodeSync(DateSearchParam.Schema)
const decodeEither = Schema.decodeUnknownEither(DateSearchParam.Schema)

describe('DateSearchParam', () => {
  it.each([
    { wire: '2026', precision: 'year' },
    { wire: '2026-07', precision: 'year-month' },
    { wire: '2026-07-27', precision: 'day' },
    { wire: '2026-07-27T14:27:30.000Z', precision: 'instant' },
  ])('should decode a bare $precision literal to the string verbatim', ({ wire }) => {
    // Act
    const decoded = decode(wire)

    // Assert — a bare value keeps its author's precision, never widened.
    expect(decoded).toBe(wire)
    expect(encode(decoded)).toBe(wire)
  })

  it.each(['eq', 'ne', 'gt', 'lt', 'ge', 'le', 'sa', 'eb', 'ap'] as const)(
    'should decode the "%s" prefix in front of a complete instant',
    (prefix) => {
      // Arrange
      const wire = `${prefix}2026-07-27T14:27:30.000Z`

      // Act
      const decoded = decode(wire)

      // Assert
      expect(decoded).toSchemaEqual(DateSearchParam.Schema, {
        prefix,
        dateTime: DateTime.unsafeMake('2026-07-27T14:27:30.000Z'),
      })
      expect(encode(decoded)).toBe(wire)
    }
  )

  it.each([
    { reason: 'a prefix in front of a year', wire: 'ge2026' },
    { reason: 'a prefix in front of a year-month', wire: 'ge2026-07' },
    { reason: 'a prefix in front of a bare date', wire: 'ge2026-07-27' },
    { reason: 'a prefix in front of a timezone-less time', wire: 'ge2026-07-27T14:27:30' },
    { reason: 'a prefix with no value', wire: 'eq' },
    { reason: 'an impossible month', wire: '2026-13' },
    { reason: 'an impossible day', wire: '2026-07-45' },
    { reason: 'a non-date string', wire: 'yesterday' },
  ])('should reject $reason', ({ wire }) => {
    // Act
    const result = decodeEither(wire)

    // Assert
    expect(Either.isLeft(result)).toBe(true)
  })

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
})
