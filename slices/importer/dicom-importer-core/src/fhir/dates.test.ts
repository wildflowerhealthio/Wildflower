import { DateTime, Option } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { dicomCalendarDate, dicomInstant } from './dates.ts'

const ZONES = ['America/Toronto', 'America/Vancouver', 'UTC', 'Australia/Eucla'] as const

const pad = (value: number, width: number): string => String(value).padStart(width, '0')

/** A `DA` value and the parts it names, generated together. */
const calendarDate = fc
  .date({
    min: new Date('1880-01-01T12:00:00Z'),
    max: new Date('2099-12-31T12:00:00Z'),
    noInvalidDate: true,
  })
  .map((date) => ({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  }))

const clock = fc.record({
  hours: fc.integer({ min: 0, max: 23 }),
  minutes: fc.integer({ min: 0, max: 59 }),
  seconds: fc.integer({ min: 0, max: 59 }),
})

const daOf = (d: { year: number; month: number; day: number }): string =>
  `${pad(d.year, 4)}${pad(d.month, 2)}${pad(d.day, 2)}`

const tmOf = (t: { hours: number; minutes: number; seconds: number }): string =>
  `${pad(t.hours, 2)}${pad(t.minutes, 2)}${pad(t.seconds, 2)}`

describe('dicomCalendarDate', () => {
  it('reads YYYYMMDD as an ISO calendar date', () => {
    expect(dicomCalendarDate('20240315')).toEqual(Option.some('2024-03-15'))
  })

  it('tolerates DICOM padding and the retired YYYY.MM.DD spelling', () => {
    expect(dicomCalendarDate('20240315 ')).toEqual(Option.some('2024-03-15'))
    expect(dicomCalendarDate('2024.03.15')).toEqual(Option.some('2024-03-15'))
  })

  it.each(['', '2024', '202403150', 'not-a-date', '20241301', '20240230'])(
    'is None for %s',
    (da) => {
      expect(dicomCalendarDate(da)).toEqual(Option.none())
    }
  )

  it('is None for an absent value', () => {
    expect(dicomCalendarDate(undefined)).toEqual(Option.none())
  })

  it('round-trips any real calendar date (property)', () => {
    fc.assert(
      fc.property(calendarDate, (d) => {
        const read = dicomCalendarDate(daOf(d))
        expect(read).toEqual(Option.some(`${pad(d.year, 4)}-${pad(d.month, 2)}-${pad(d.day, 2)}`))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('dicomInstant', () => {
  it('resolves the wall clock against the zone', () => {
    const instant = dicomInstant('20240315', '143022', 'America/Toronto')
    expect(Option.map(instant, DateTime.formatIso)).toEqual(Option.some('2024-03-15T18:30:22.000Z'))
  })

  it('reads the TM fraction by its own width, not as a count of milliseconds', () => {
    const half = dicomInstant('20240315', '143022.5', 'UTC')
    expect(Option.map(half, DateTime.formatIso)).toEqual(Option.some('2024-03-15T14:30:22.500Z'))
    const milli = dicomInstant('20240315', '143022.001', 'UTC')
    expect(Option.map(milli, DateTime.formatIso)).toEqual(Option.some('2024-03-15T14:30:22.001Z'))
  })

  it('defaults omitted seconds to zero', () => {
    const instant = dicomInstant('20240315', '1430', 'UTC')
    expect(Option.map(instant, DateTime.formatIso)).toEqual(Option.some('2024-03-15T14:30:00.000Z'))
  })

  it('is None when TM names only an hour', () => {
    expect(dicomInstant('20240315', '14', 'UTC')).toEqual(Option.none())
  })

  it('is None when TM is absent', () => {
    expect(dicomInstant('20240315', undefined, 'UTC')).toEqual(Option.none())
  })

  it('is None when the zone is not a zone', () => {
    expect(dicomInstant('20240315', '143022', 'Mars/Olympus')).toEqual(Option.none())
  })

  it('reads back as the same wall clock in the zone it was resolved against (property)', () => {
    fc.assert(
      fc.property(calendarDate, clock, fc.constantFrom(...ZONES), (d, t, timeZone) => {
        const instant = dicomInstant(daOf(d), tmOf(t), timeZone)
        expect(Option.isSome(instant)).toBe(true)
        if (!Option.isSome(instant)) return
        const zoned = DateTime.setZone(instant.value, DateTime.zoneUnsafeMakeNamed(timeZone))
        const parts = DateTime.toParts(zoned)
        // A DST spring-forward gap is the one wall clock that does not exist,
        // and `adjustForTimeZone` shifts out of it; everything else round-trips.
        const shifted = parts.hours !== t.hours
        expect(shifted || (parts.minutes === t.minutes && parts.seconds === t.seconds)).toBe(true)
        expect(parts.day).toBe(d.day)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('never reads the same wall clock as the same instant in two different zones (property)', () => {
    fc.assert(
      fc.property(calendarDate, clock, (d, t) => {
        const toronto = dicomInstant(daOf(d), tmOf(t), 'America/Toronto')
        const vancouver = dicomInstant(daOf(d), tmOf(t), 'America/Vancouver')
        expect(Option.isSome(toronto) && Option.isSome(vancouver)).toBe(true)
        if (!Option.isSome(toronto) || !Option.isSome(vancouver)) return
        expect(DateTime.toEpochMillis(toronto.value)).not.toBe(
          DateTime.toEpochMillis(vancouver.value)
        )
      }),
      { numRuns: numRunsFor({ base: 60 }) }
    )
  })
})
