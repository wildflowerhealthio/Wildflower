import { DateTime, Option } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { parsePrintedDate, parsePrintedDateTime } from './dates.ts'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A calendar date the report could print, with its components. */
const calendarDate = fc
  .record({
    year: fc.integer({ min: 1900, max: 2100 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
  })
  .map((parts) => ({
    ...parts,
    printed: `${MONTHS[parts.month - 1]} ${parts.day} ${parts.year}`,
    iso: `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
  }))

describe('parsePrintedDate', () => {
  it('property: reads any printed calendar date to its ISO form', () => {
    fc.assert(
      fc.property(calendarDate, (date) => {
        expect(parsePrintedDate(date.printed)).toEqual(Option.some(date.iso))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('is None for a masked or malformed date', () => {
    expect(parsePrintedDate('Xxx 00 0000')).toEqual(Option.none())
    expect(parsePrintedDate('')).toEqual(Option.none())
    expect(parsePrintedDate('2026-08-13')).toEqual(Option.none())
    expect(parsePrintedDate('Feb 30 2026')).toEqual(Option.none())
  })
})

describe('parsePrintedDateTime', () => {
  it('property: a printed clock time in a zone is that wall-clock time when read back in the zone', () => {
    const zone = fc.constantFrom('America/Toronto', 'America/Vancouver', 'UTC')
    const clock = fc.record({
      hours: fc.integer({ min: 0, max: 23 }),
      minutes: fc.integer({ min: 0, max: 59 }),
    })
    fc.assert(
      fc.property(calendarDate, clock, zone, (date, time, timeZone) => {
        const printed = `${date.printed} ${String(time.hours).padStart(2, '0')}:${String(time.minutes).padStart(2, '0')}`

        const utc = parsePrintedDateTime(printed, timeZone)

        expect(Option.isSome(utc)).toBe(true)
        if (Option.isNone(utc)) return
        const zoned = DateTime.setZone(utc.value, DateTime.zoneUnsafeMakeNamed(timeZone))
        const parts = DateTime.toParts(zoned)
        expect([parts.year, parts.month, parts.day, parts.hours, parts.minutes]).toEqual([
          date.year,
          date.month,
          date.day,
          time.hours,
          time.minutes,
        ])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('applies the zone: 13:02 in Toronto in August is 17:02Z', () => {
    expect(
      Option.map(parsePrintedDateTime('Aug 13 2026 13:02', 'America/Toronto'), DateTime.formatIso)
    ).toEqual(Option.some('2026-08-13T17:02:00.000Z'))
  })

  it('reads a printed date with no time as midnight in the zone', () => {
    expect(
      Option.map(parsePrintedDateTime('Jan 19 2024', 'America/Toronto'), DateTime.formatIso)
    ).toEqual(Option.some('2024-01-19T05:00:00.000Z'))
  })

  it('is None for a masked value or an unknown zone', () => {
    expect(parsePrintedDateTime('Xxx 00 0000 00:00', 'America/Toronto')).toEqual(Option.none())
    expect(parsePrintedDateTime('Aug 13 2026 13:02', 'Not/AZone')).toEqual(Option.none())
    expect(parsePrintedDateTime('', 'America/Toronto')).toEqual(Option.none())
  })
})
