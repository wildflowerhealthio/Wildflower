import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { DateTime, Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { endOfPartialDate } from './partial-date.ts'

const twoDigits = (value: number): string => String(value).padStart(2, '0')

/**
 * A partial date at each precision, with the epoch-ms of the next day, month
 * or year's start, computed by `Date.UTC` rather than the subject's own rule.
 */
const partialDateArb = fc
  .record({
    year: fc.integer({ min: 1000, max: 9999 }),
    month: fc.integer({ min: 1, max: 12 }),
    dayFraction: fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
    precision: fc.constantFrom('year', 'month', 'day'),
  })
  .map(({ year, month, dayFraction, precision }) => {
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const day = 1 + Math.floor(dayFraction * daysInMonth)
    if (precision === 'year') return { text: String(year), nextStart: Date.UTC(year + 1, 0, 1) }
    if (precision === 'month')
      return { text: `${year}-${twoDigits(month)}`, nextStart: Date.UTC(year, month, 1) }
    return {
      text: `${year}-${twoDigits(month)}-${twoDigits(day)}`,
      nextStart: Date.UTC(year, month - 1, day + 1),
    }
  })

describe('endOfPartialDate', () => {
  test('property: is 1 ms before the start of the next day, month or year', () => {
    fc.assert(
      fc.property(partialDateArb, ({ text, nextStart }) => {
        const end = Option.getOrThrow(endOfPartialDate(text))
        expect(DateTime.toEpochMillis(end) + 1).toBe(nextStart)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test.each(['2026-03-31T09:00:00Z', '2026-13', 'not a date', ''])('is None for %j', (text) => {
    expect(endOfPartialDate(text)).toEqual(Option.none())
  })
})
