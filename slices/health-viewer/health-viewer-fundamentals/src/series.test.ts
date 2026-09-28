import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import {
  levelFrom,
  levelSeriesArb,
  levelSeriesOf,
  pointSeriesArb,
  seriesArb,
  smallMillis,
} from './arbitraries.test-helpers.ts'
import * as LevelSeries from './level-series.ts'
import * as Level from './level.ts'
import * as PointSeries from './point-series.ts'
import * as Series from './series.ts'

const RUNS = numRunsFor({ base: 200 })

describe('Series.levelsOf', () => {
  test('a point series reads as its readings held; a level series as its own levels', () => {
    fc.assert(
      fc.property(pointSeriesArb, levelSeriesArb, (points, levels) => {
        expect(Series.levelsOf(points)).toEqual(PointSeries.toLevels(points))
        expect(Series.levelsOf(levels)).toBe(levels.levels)
      }),
      { numRuns: RUNS }
    )
  })
})

describe('Series.levelAt', () => {
  test('reads through the series kind’s own lookup', () => {
    fc.assert(
      fc.property(seriesArb, smallMillis, (series, millis) => {
        const time = DateTime.unsafeMake(millis)
        const expected =
          series.kind === 'points'
            ? PointSeries.levelAt(series, time)
            : LevelSeries.levelAt(series, time)
        expect(Series.levelAt(series, time)).toEqual(expected)
      }),
      { numRuns: RUNS }
    )
  })

  test('a level series reads the level in effect, and nothing in a gap', () => {
    fc.assert(
      fc.property(levelSeriesArb, smallMillis, (series, millis) => {
        const time = DateTime.unsafeMake(millis)
        expect(Series.levelAt(series, time)).toBe(Level.inEffectAt(series.levels, time))
      }),
      { numRuns: RUNS }
    )
    const series = levelSeriesOf([levelFrom(0, 10, 5), levelFrom(100, 110, 7)])
    expect(Series.levelAt(series, DateTime.unsafeMake(50))).toBeNull()
  })
})

describe('Series.extentOf', () => {
  test('spans every stated boundary, and nothing when the series is empty', () => {
    fc.assert(
      fc.property(seriesArb, (series) => {
        const boundaries = Series.levelsOf(series).flatMap((level) => [
          level.start.epochMillis,
          ...(level.end === null ? [] : [level.end.epochMillis]),
        ])
        const extent = Series.extentOf(series)
        if (boundaries.length === 0) expect(extent).toBeNull()
        else {
          expect(extent?.[0].epochMillis).toBe(Math.min(...boundaries))
          expect(extent?.[1].epochMillis).toBe(Math.max(...boundaries))
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('a point series spans its first to its last reading', () => {
    fc.assert(
      fc.property(pointSeriesArb, (series) => {
        const millis = series.points.map((point) => point.time.epochMillis)
        const extent = Series.extentOf(series)
        if (millis.length === 0) expect(extent).toBeNull()
        else
          expect(extent?.map((time) => time.epochMillis)).toEqual([
            Math.min(...millis),
            Math.max(...millis),
          ])
      }),
      { numRuns: RUNS }
    )
  })
})

describe('Series.sizeOf', () => {
  test('counts readings or levels', () => {
    fc.assert(
      fc.property(seriesArb, (series) => {
        expect(Series.sizeOf(series)).toBe(Series.levelsOf(series).length)
      }),
      { numRuns: RUNS }
    )
  })
})
