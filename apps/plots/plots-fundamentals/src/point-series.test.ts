import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { pointSeriesArb, pointSeriesOf, smallMillis } from './arbitraries.test-helpers.ts'
import * as Level from './level.ts'
import * as PointSeries from './point-series.ts'

const RUNS = numRunsFor({ base: 200 })

/**
 * The reading a crosshair names at `time`, by a linear scan: the last one at
 * or before it, else the first. Kept apart from the binary search so a bug
 * there cannot hide in a shared helper.
 */
const readingAtByScan = (
  points: readonly PointSeries.Point[],
  time: DateTime.Utc
): PointSeries.Point | null => {
  if (points.length === 0) return null
  const before = points.filter((point) => point.time.epochMillis <= time.epochMillis)
  return before.length === 0 ? points[0] : before[before.length - 1]
}

describe('PointSeries.toLevels', () => {
  test('one level per reading, in order, each starting at its reading', () => {
    fc.assert(
      fc.property(pointSeriesArb, (series) => {
        const levels = PointSeries.toLevels(series)
        expect(levels).toHaveLength(series.points.length)
        levels.forEach((level, index) => {
          const point = series.points[index]
          expect(level.start).toBe(point.time)
          expect(level.value).toBe(point.value)
          expect(level.low).toBe(point.low)
          expect(level.high).toBe(point.high)
        })
      }),
      { numRuns: RUNS }
    )
  })

  test('levels are sorted and never overlap: each ends exactly where the next starts', () => {
    fc.assert(
      fc.property(pointSeriesArb, (series) => {
        const levels = PointSeries.toLevels(series)
        for (let index = 0; index + 1 < levels.length; index += 1) {
          const end = levels[index].end
          expect(end).not.toBeNull()
          expect(end?.epochMillis).toBe(levels[index + 1].start.epochMillis)
          expect(levels[index].start.epochMillis).toBeLessThanOrEqual(
            levels[index + 1].start.epochMillis
          )
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('only the last reading is held open-ended', () => {
    fc.assert(
      fc.property(pointSeriesArb, (series) => {
        const levels = PointSeries.toLevels(series)
        expect(levels.map((level) => level.end === null)).toEqual(
          levels.map((_, index) => index === levels.length - 1)
        )
      }),
      { numRuns: RUNS }
    )
  })

  test('a reading without a band or note yields a level without those keys', () => {
    const [level] = PointSeries.toLevels(
      pointSeriesOf([{ time: DateTime.unsafeMake(0), value: 1 }])
    )
    expect(Object.keys(level).toSorted()).toEqual(['end', 'start', 'value'])
  })

  test("a reading's note rides along on its level", () => {
    const [level] = PointSeries.toLevels(
      pointSeriesOf([{ time: DateTime.unsafeMake(0), value: 1, note: 'fasting' }])
    )
    expect(level.note).toBe('fasting')
  })
})

describe('PointSeries.levelAt', () => {
  test('names the same reading as a scan: the last at or before, else the first', () => {
    fc.assert(
      fc.property(pointSeriesArb, smallMillis, (series, millis) => {
        const time = DateTime.unsafeMake(millis)
        const expected = readingAtByScan(series.points, time)
        const found = PointSeries.levelAt(series, time)
        if (expected === null) expect(found).toBeNull()
        else {
          expect(found?.start).toBe(expected.time)
          expect(found?.value).toBe(expected.value)
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('is the level toLevels holds there, with the first standing in before the data', () => {
    fc.assert(
      fc.property(pointSeriesArb, smallMillis, (series, millis) => {
        const time = DateTime.unsafeMake(millis)
        const levels = PointSeries.toLevels(series)
        expect(PointSeries.levelAt(series, time)).toEqual(
          Level.inEffectAt(levels, time) ?? levels[0] ?? null
        )
      }),
      { numRuns: RUNS }
    )
  })

  test('a crosshair landing exactly on a reading reads that reading, the last of any ties', () => {
    fc.assert(
      fc.property(
        pointSeriesArb
          .filter((series) => series.points.length > 0)
          .chain((series) =>
            fc.tuple(fc.constant(series), fc.integer({ min: 0, max: series.points.length - 1 }))
          ),
        ([series, index]) => {
          const target = series.points[index]
          const found = PointSeries.levelAt(series, target.time)
          expect(found?.start.epochMillis).toBe(target.time.epochMillis)
          expect(found?.value).toBe(readingAtByScan(series.points, target.time)?.value)
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('a crosshair before the data still names the first reading', () => {
    const series = pointSeriesOf([
      { time: DateTime.unsafeMake(100), value: 1 },
      { time: DateTime.unsafeMake(200), value: 2 },
    ])
    expect(PointSeries.levelAt(series, DateTime.unsafeMake(0))?.value).toBe(1)
  })

  test('an empty series reads nothing', () => {
    expect(PointSeries.levelAt(pointSeriesOf([]), DateTime.unsafeMake(0))).toBeNull()
  })
})
