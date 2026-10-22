import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import {
  anySeriesArb,
  levelFrom,
  levelSeriesArb,
  levelSeriesOf,
  pointSeriesArb,
  seriesArb,
  smallMillis,
  spanFrom,
  spanSeriesArb,
  spanSeriesOf,
  windowArb,
} from './arbitraries.test-helpers.ts'
import * as LevelSeries from './level-series.ts'
import * as Level from './level.ts'
import * as PointSeries from './point-series.ts'
import * as Series from './series.ts'
import { type TimeDomain, contains } from './time-domain.ts'

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

describe('Series.levelsWithin', () => {
  /** A series with a window over it, its ends often on the series' own boundaries. */
  const seriesWithWindowArb = fc
    .tuple(seriesArb, windowArb, fc.nat(), fc.nat())
    .map(([series, window, fromIndex, toIndex]): readonly [Series.ValueSeries, TimeDomain] => {
      const instants = Series.boundariesOf(series)
      if (instants.length === 0) return [series, window]
      const [from, to] = [
        instants[fromIndex % instants.length],
        instants[toIndex % instants.length],
      ]
      return [series, from.epochMillis <= to.epochMillis ? [from, to] : [to, from]]
    })

  test('is exactly the levels of levelsOf that start inside the window, in series order', () => {
    fc.assert(
      fc.property(seriesWithWindowArb, ([series, window]) => {
        expect(Series.levelsWithin(series, window)).toEqual(
          Series.levelsOf(series).filter((level) => contains(window, level.start.epochMillis))
        )
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
      fc.property(anySeriesArb, (series) => {
        const boundaries =
          series.kind === 'spans'
            ? series.spans.flatMap((span) => [span.start.epochMillis, span.end.epochMillis])
            : Series.levelsOf(series).flatMap((level) => [
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

describe('Series.extentOfAll', () => {
  test('is the hull of each series’ own extent, and nothing when none has one', () => {
    fc.assert(
      fc.property(fc.array(anySeriesArb, { maxLength: 5 }), (seriesList) => {
        const extents = seriesList.flatMap((series) => {
          const extent = Series.extentOf(series)
          return extent === null ? [] : [extent]
        })
        const extent = Series.extentOfAll(seriesList)
        if (extents.length === 0) expect(extent).toBeNull()
        else {
          expect(extent?.[0].epochMillis).toBe(
            Math.min(...extents.map(([start]) => start.epochMillis))
          )
          expect(extent?.[1].epochMillis).toBe(
            Math.max(...extents.map(([, end]) => end.epochMillis))
          )
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('of one series is that series’ extent', () => {
    fc.assert(
      fc.property(anySeriesArb, (series) => {
        expect(Series.extentOfAll([series])).toEqual(Series.extentOf(series))
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

  test('counts spans', () => {
    fc.assert(
      fc.property(spanSeriesArb, (series) => {
        expect(Series.sizeOf(series)).toBe(series.spans.length)
      }),
      { numRuns: RUNS }
    )
  })
})

describe('Series.isSpanSeries', () => {
  test('is true exactly for span series, the complement of isValueSeries', () => {
    fc.assert(
      fc.property(anySeriesArb, (series) => {
        expect(Series.isSpanSeries(series)).toBe(series.kind === 'spans')
        expect(Series.isSpanSeries(series)).toBe(!Series.isValueSeries(series))
      }),
      { numRuns: RUNS }
    )
  })
})

describe('Series.isValueSeries', () => {
  test('is true exactly for the kinds that take a value axis', () => {
    fc.assert(
      fc.property(anySeriesArb, (series) => {
        expect(Series.isValueSeries(series)).toBe(series.kind !== 'spans')
      }),
      { numRuns: RUNS }
    )
  })

  test('a span series spans its earliest start to its latest end', () => {
    const series = spanSeriesOf([spanFrom(10, 500), spanFrom(20, 30)])
    expect(Series.extentOf(series)?.map((time) => time.epochMillis)).toEqual([10, 500])
  })
})
