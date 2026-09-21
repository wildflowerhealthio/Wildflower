import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import {
  PRESET_LOOKBACK,
  RANGE_PRESETS,
  type RangePreset,
  type TimeDomain,
  isRangePreset,
  pointsWithin,
  xDomain,
} from './time-range.ts'

const RUNS = numRunsFor({ base: 200 })

const instant = fc.integer({ min: 0, max: 4e12 }).map((millis) => DateTime.unsafeMake(millis))
const bounded = fc.constantFrom(...RANGE_PRESETS.filter((preset) => preset !== 'all'))
const extent: fc.Arbitrary<TimeDomain> = fc
  .tuple(instant, instant)
  .map(([left, right]): TimeDomain =>
    left.epochMillis <= right.epochMillis ? [left, right] : [right, left]
  )

describe('isRangePreset', () => {
  test('accepts exactly the declared presets', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(isRangePreset(value)).toBe((RANGE_PRESETS as readonly string[]).includes(value))
      }),
      { numRuns: RUNS }
    )
  })
})

describe('xDomain', () => {
  test("'all' returns the data extent unchanged", () => {
    fc.assert(
      fc.property(instant, extent, (now, dataExtent) => {
        expect(xDomain('all', now, dataExtent)).toEqual(dataExtent)
      }),
      { numRuns: RUNS }
    )
  })

  const DAY_MILLIS = 86_400_000

  /**
   * The days a lookback can span, read off the declared table and the
   * calendar's own definition of a year — not off a second copy of the
   * durations, which would pin the implementation rather than check it.
   */
  const spanDays = (
    lookback: Partial<DateTime.DateTime.PartsForMath>
  ): { readonly min: number; readonly max: number } => {
    const days = lookback.days ?? 0
    const years = lookback.years ?? 0
    return { min: days + years * 365, max: days + years * 366 }
  }

  test('a bounded preset ends at now and spans its stated lookback', () => {
    fc.assert(
      fc.property(bounded, instant, extent, (preset, now, dataExtent) => {
        const [start, end] = xDomain(preset, now, dataExtent)
        expect(end).toEqual(now)
        const spanned = (end.epochMillis - start.epochMillis) / DAY_MILLIS
        const { min, max } = spanDays(PRESET_LOOKBACK[preset])
        expect(spanned).toBeGreaterThanOrEqual(min)
        expect(spanned).toBeLessThanOrEqual(max)
      }),
      { numRuns: RUNS }
    )
  })

  test('a year lookback is calendar arithmetic, so it clamps onto a leap day', () => {
    // Not invertible: subtracting a year from Feb 29 lands on Feb 28, and
    // adding one back does not return. The span assertion above is stated in
    // days for exactly this reason.
    const [start] = xDomain('1y', DateTime.unsafeMake('2016-02-29T00:00:00Z'), null)
    expect(DateTime.formatIso(start)).toBe('2015-02-28T00:00:00.000Z')
  })

  test('a bounded preset ignores the data extent entirely', () => {
    fc.assert(
      fc.property(bounded, instant, extent, (preset, now, dataExtent) => {
        expect(xDomain(preset, now, dataExtent)).toEqual(xDomain(preset, now, null))
      }),
      { numRuns: RUNS }
    )
  })

  test("'all' with no data falls back to a drawable year ending at now", () => {
    fc.assert(
      fc.property(instant, (now) => {
        const [start, end] = xDomain('all', now, null)
        expect(end).toEqual(now)
        expect(start).toEqual(xDomain('1y', now, null)[0])
      }),
      { numRuns: RUNS }
    )
  })

  test('every preset yields a start at or before its end', () => {
    fc.assert(
      fc.property(fc.constantFrom(...RANGE_PRESETS), instant, extent, (preset, now, dataExtent) => {
        const [start, end] = xDomain(preset, now, dataExtent)
        expect(start.epochMillis).toBeLessThanOrEqual(end.epochMillis)
      }),
      { numRuns: RUNS }
    )
  })

  test('the lookback table covers every bounded preset', () => {
    const covered: readonly RangePreset[] = Object.keys(PRESET_LOOKBACK).filter(isRangePreset)
    expect(covered.toSorted()).toEqual(
      RANGE_PRESETS.filter((preset) => preset !== 'all').toSorted()
    )
  })
})

describe('pointsWithin', () => {
  test('keeps exactly the points inside the domain, in input order', () => {
    fc.assert(
      fc.property(fc.array(instant, { maxLength: 20 }), extent, (times, domain) => {
        const points = times.map((time, index) => ({ time, index }))
        const kept = pointsWithin(points, domain)
        expect(kept).toEqual(
          points.filter(
            (point) =>
              point.time.epochMillis >= domain[0].epochMillis &&
              point.time.epochMillis <= domain[1].epochMillis
          )
        )
      }),
      { numRuns: RUNS }
    )
  })

  test('the domain endpoints are included', () => {
    fc.assert(
      fc.property(extent, (domain) => {
        const points = [{ time: domain[0] }, { time: domain[1] }]
        expect(pointsWithin(points, domain)).toEqual(points)
      }),
      { numRuns: RUNS }
    )
  })
})
