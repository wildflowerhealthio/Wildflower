import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import type { TimeDomain } from '@wildflowerhealthio/health-viewer-fundamentals'

import {
  PRESET_LOOKBACK,
  RANGE_PRESETS,
  type RangePreset,
  isRangePreset,
  xDomain,
} from './time-range.ts'

const RUNS = numRunsFor({ base: 200 })

const instant = fc.integer({ min: 0, max: 4e12 }).map((millis) => DateTime.unsafeMake(millis))
const bounded = fc.constantFrom(...RANGE_PRESETS.filter((preset) => preset !== 'all'))
const extent: fc.Arbitrary<TimeDomain.TimeDomain> = fc
  .tuple(instant, instant)
  .map(([left, right]): TimeDomain.TimeDomain =>
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

  const HOUR_MILLIS = 3_600_000
  const DAY_MILLIS = 24 * HOUR_MILLIS

  /**
   * The days a lookback can span, read off the declared table and the
   * calendar's own definition of a year — not off a second copy of the
   * durations, which would pin the implementation rather than check it.
   */
  const spanDays = (
    lookback: Partial<DateTime.DateTime.PartsForMath>
  ): { readonly min: number; readonly max: number } => {
    const days = (lookback.days ?? 0) + (lookback.hours ?? 0) / 24
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

  test.each([
    ['24h', HOUR_MILLIS * 24],
    ['7d', DAY_MILLIS * 7],
  ] as const)('%s reaches back exactly %i ms, sub-day parts included', (preset, millis) => {
    const now = DateTime.unsafeMake('2024-03-10T09:30:15.250Z')
    const [start, end] = xDomain(preset, now, null)
    expect(end.epochMillis - start.epochMillis).toBe(millis)
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
