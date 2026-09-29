import { DateTime, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { CarebookTimestamp, carebookTimestampOf } from './carebook-timestamp.ts'
import profileMe from './fixtures/profile-me.json' with { type: 'json' }

const decodeTimestamp = Schema.decodeUnknownEither(CarebookTimestamp)

describe('CarebookTimestamp', () => {
  it('writes an instant at second precision with a +00:00 offset', () => {
    expect(carebookTimestampOf(DateTime.unsafeMake('2024-03-11T16:54:30.789Z'))).toBe(
      '2024-03-11T16:54:30+00:00'
    )
  })

  it("round-trips the capture's timestamps byte for byte", () => {
    for (const captured of [profileMe.data.createdOn, profileMe.data.updatedOn]) {
      const decoded = Schema.decodeUnknownSync(CarebookTimestamp)(captured)
      expect(carebookTimestampOf(decoded)).toBe(captured)
    }
  })

  it('decodes what it encodes, to the same second', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('1970-01-01T00:00:00Z'),
          max: new Date('2100-01-01T00:00:00Z'),
          noInvalidDate: true,
        }),
        (date) => {
          const instant = DateTime.unsafeMake(date)
          const decoded = Schema.decodeUnknownSync(CarebookTimestamp)(carebookTimestampOf(instant))
          expect(DateTime.toEpochMillis(decoded)).toBe(
            Math.floor(DateTime.toEpochMillis(instant) / 1000) * 1000
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it.each([
    { timestamp: '2024-03-11T16:54:30Z' },
    { timestamp: '2024-03-11T16:54:30.000+00:00' },
    { timestamp: '2024-03-11T12:54:30-04:00' },
    { timestamp: '2024-03-11' },
  ])('rejects $timestamp, which is not the carebook form', ({ timestamp }) => {
    expect(Either.isLeft(decodeTimestamp(timestamp))).toBe(true)
  })
})
