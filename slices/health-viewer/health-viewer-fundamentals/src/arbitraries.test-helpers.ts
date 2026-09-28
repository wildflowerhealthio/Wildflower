import { DateTime } from 'effect'
import * as fc from 'fast-check'

import type * as LevelSeries from './level-series.ts'
import type * as PointSeries from './point-series.ts'
import type * as Series from './series.ts'

/** An instant within a small window, so generated series collide and interleave. */
const smallMillis = fc.integer({ min: 0, max: 1_000_000 })

const finite = fc.double({ min: -1e9, max: 1e9, noNaN: true })

/** A band from two finite bounds, or none; absent keys rather than `undefined` ones. */
const bandArb: fc.Arbitrary<{ readonly low?: number; readonly high?: number }> = fc
  .option(fc.tuple(finite, finite), { nil: null })
  .map((bounds) => (bounds === null ? {} : { low: Math.min(...bounds), high: Math.max(...bounds) }))

/** A point series built from readings in any order, sorted as the type requires. */
const pointSeriesOf = (
  points: readonly PointSeries.Point[],
  valueScale: Series.ValueScale = 'fitted'
): PointSeries.PointSeries => ({
  kind: 'points',
  id: 'p:series',
  label: 'Readings',
  unit: 'u',
  valueScale,
  interpolation: 'linear',
  points: points.toSorted((left, right) => left.time.epochMillis - right.time.epochMillis),
})

/** A level series built from levels in any order, sorted by `start` as the type requires. */
const levelSeriesOf = (
  levels: readonly LevelSeries.StyledLevel[],
  valueScale: Series.ValueScale = 'from-zero'
): LevelSeries.LevelSeries => ({
  kind: 'levels',
  id: 'l:series',
  label: 'Levels',
  unit: 'u',
  valueScale,
  levels: levels.toSorted((left, right) => left.start.epochMillis - right.start.epochMillis),
})

/** A level held from `start` to `end` (`null` = open), solid. */
const levelFrom = (
  start: number,
  end: number | null,
  value: number = 1
): LevelSeries.StyledLevel => ({
  start: DateTime.unsafeMake(start),
  end: end === null ? null : DateTime.unsafeMake(end),
  value,
  lineStyle: 'solid',
})

const pointArb: fc.Arbitrary<PointSeries.Point> = fc
  .record({ millis: smallMillis, value: finite, band: bandArb })
  .map(({ millis, value, band }) => ({ time: DateTime.unsafeMake(millis), value, ...band }))

const pointSeriesArb: fc.Arbitrary<PointSeries.PointSeries> = fc
  .array(pointArb, { maxLength: 20 })
  .map((points) => pointSeriesOf(points))

/** Levels that may overlap, leave gaps, or stay open — everything a level series allows. */
const levelSeriesArb: fc.Arbitrary<LevelSeries.LevelSeries> = fc
  .array(
    fc.record({
      start: smallMillis,
      length: fc.option(fc.integer({ min: 0, max: 200_000 }), { nil: null }),
      value: fc.double({ min: 0, max: 1e6, noNaN: true }),
      lineStyle: fc.constantFrom('solid' as const, 'dashed' as const),
    }),
    { maxLength: 8 }
  )
  .map((drafts) =>
    levelSeriesOf(
      drafts.map(({ start, length, value, lineStyle }) => ({
        ...levelFrom(start, length === null ? null : start + length, value),
        lineStyle,
      }))
    )
  )

const seriesArb: fc.Arbitrary<Series.Series> = fc.oneof(pointSeriesArb, levelSeriesArb)

export {
  levelFrom,
  levelSeriesArb,
  levelSeriesOf,
  pointArb,
  pointSeriesArb,
  pointSeriesOf,
  seriesArb,
  smallMillis,
}
