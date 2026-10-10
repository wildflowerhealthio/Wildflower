import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { levelFrom, levelSeriesArb, smallMillis } from './arbitraries.test-helpers.ts'
import * as Level from './level.ts'

const RUNS = numRunsFor({ base: 200 })

/**
 * The obvious, slow reading of the same rule, for the binary search to be
 * checked against: of every level that covers the instant, the one latest in
 * start order. Written as a scan so a bug in the search cannot hide in a
 * shared helper.
 */
const inEffectAtByScan = (levels: readonly Level.Level[], time: DateTime.Utc): Level.Level | null =>
  levels
    .filter(
      (level) =>
        level.start.epochMillis <= time.epochMillis &&
        (level.end === null || level.end.epochMillis >= time.epochMillis)
    )
    .at(-1) ?? null

describe('Level.inEffectAt', () => {
  test('agrees with a scan of the same rule, overlaps and gaps included', () => {
    fc.assert(
      fc.property(levelSeriesArb, smallMillis, (series, millis) => {
        const time = DateTime.unsafeMake(millis)
        expect(Level.inEffectAt(series.levels, time)).toBe(inEffectAtByScan(series.levels, time))
      }),
      { numRuns: RUNS }
    )
  })

  test('the result, when there is one, actually covers the instant', () => {
    fc.assert(
      fc.property(levelSeriesArb, smallMillis, (series, millis) => {
        const found = Level.inEffectAt(series.levels, DateTime.unsafeMake(millis))
        if (found === null) return
        expect(found.start.epochMillis).toBeLessThanOrEqual(millis)
        expect(found.end === null || found.end.epochMillis >= millis).toBe(true)
      }),
      { numRuns: RUNS }
    )
  })

  test('overlapping levels resolve to the latest one that has started', () => {
    const levels = [levelFrom(0, 100, 5), levelFrom(50, 100, 10)]
    expect(Level.inEffectAt(levels, DateTime.unsafeMake(75))?.value).toBe(10)
  })

  test('an earlier level still covering the instant is found past a later one that ended', () => {
    const levels = [levelFrom(0, 1000, 5), levelFrom(50, 60, 10)]
    expect(Level.inEffectAt(levels, DateTime.unsafeMake(75))?.value).toBe(5)
  })

  test('an open-ended level stays in effect indefinitely', () => {
    expect(Level.inEffectAt([levelFrom(0, null, 5)], DateTime.unsafeMake(999_999))?.value).toBe(5)
  })

  test('a gap between levels reads as nothing in effect, not as the nearest level', () => {
    const levels = [levelFrom(0, 10, 5), levelFrom(100, 110, 7)]
    expect(Level.inEffectAt(levels, DateTime.unsafeMake(50))).toBeNull()
    expect(Level.inEffectAt(levels, DateTime.unsafeMake(-1))).toBeNull()
  })

  test('both ends are inclusive', () => {
    const levels = [levelFrom(10, 20, 5)]
    expect(Level.inEffectAt(levels, DateTime.unsafeMake(10))?.value).toBe(5)
    expect(Level.inEffectAt(levels, DateTime.unsafeMake(20))?.value).toBe(5)
  })
})
