import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { asOfArbitrary } from '../test-helpers.ts'
import * as StoryDay from './story-day.ts'

const RUNS = numRunsFor({ base: 200 })

const storyDayArbitrary = fc.integer({ min: -3000, max: 30 })
const keysArbitrary = fc.array(fc.string(), { minLength: 1, maxLength: 4 })

/** An hour window `[from, to)` within one UTC day. */
const hoursArbitrary = fc
  .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 1, max: 24 }))
  .map(([from, span]) => ({ from, to: Math.min(24, from + span) }))

describe('StoryDay.toIsoDate', () => {
  test('property: counts calendar days from the as-of day', () => {
    fc.assert(
      fc.property(asOfArbitrary, storyDayArbitrary, (asOf, storyDay) => {
        const asOfMidnight = Date.parse(`${DateTime.formatIsoDate(asOf)}T00:00:00Z`)
        const dated = Date.parse(`${StoryDay.toIsoDate(asOf, storyDay)}T00:00:00Z`)
        expect((dated - asOfMidnight) / 86_400_000).toBe(storyDay)
      }),
      { numRuns: RUNS }
    )
  })
})

describe('StoryDay.instantOn', () => {
  test('property: falls on the story day, inside the hour window', () => {
    fc.assert(
      fc.property(
        asOfArbitrary,
        storyDayArbitrary,
        keysArbitrary,
        hoursArbitrary,
        (asOf, storyDay, keys, hours) => {
          const instant = StoryDay.instantOn(asOf, storyDay, keys, hours.from, hours.to)
          expect(DateTime.formatIsoDate(instant)).toBe(StoryDay.toIsoDate(asOf, storyDay))
          const secondOfDay =
            (DateTime.toEpochMillis(instant) -
              DateTime.toEpochMillis(StoryDay.toDateTime(asOf, storyDay))) /
            1000
          expect(Number.isInteger(secondOfDay)).toBe(true)
          expect(secondOfDay).toBeGreaterThanOrEqual(hours.from * 3600)
          expect(secondOfDay).toBeLessThan(hours.to * 3600)
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('property: depends on the as-of calendar day and the keys, not the as-of time', () => {
    fc.assert(
      fc.property(
        asOfArbitrary,
        fc.integer({ min: 0, max: 86_399_999 }),
        storyDayArbitrary,
        keysArbitrary,
        hoursArbitrary,
        (asOf, millisIntoDay, storyDay, keys, hours) => {
          const sameDay = DateTime.add(StoryDay.asOfDayOf(asOf), { millis: millisIntoDay })
          expect(StoryDay.instantOn(sameDay, storyDay, keys, hours.from, hours.to)).toEqual(
            StoryDay.instantOn(asOf, storyDay, keys, hours.from, hours.to)
          )
        }
      ),
      { numRuns: RUNS }
    )
  })
})
