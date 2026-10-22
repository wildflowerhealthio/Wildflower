import type { DateTime } from 'effect'

import * as LevelSeries from './level-series.ts'
import type * as Level from './level.ts'
import * as PointSeries from './point-series.ts'
import type * as SpanSeries from './span-series.ts'
import { type TimeDomain, contains } from './time-domain.ts'

/**
 * How a series' value axis is fitted, decided by the domain that knows what
 * the numbers mean.
 *
 * - `'fitted'`: around the values and their bands, rounded outward.
 * - `'from-zero'`: from zero up to the largest value — for a non-negative
 *   magnitude, where a zoomed-in baseline would overstate a change.
 * - `'zero-to-one'`: exactly `[0, 1]` — for a yes/no reading plotted as 0 / 1.
 */
type ValueScale = 'fitted' | 'from-zero' | 'zero-to-one'

/** A series of values, drawn against a value axis of its own or one it shares (`ValueAxis.assign`). */
type ValueSeries = PointSeries.PointSeries | LevelSeries.LevelSeries

/** Anything the chart plots; discriminate on `kind`. */
type Series = ValueSeries | SpanSeries.SpanSeries

/** Whether `series` takes a value axis — a point or level series, not a span lane. */
const isValueSeries = (series: Series): series is ValueSeries => series.kind !== 'spans'

/** Whether `series` is a span lane — drawn under the time axis, against no value axis. */
const isSpanSeries = (series: Series): series is SpanSeries.SpanSeries => series.kind === 'spans'

/**
 * `series` as levels — a point series' readings each held until the next one
 * (`PointSeries.toLevels`), a level series' own levels.
 *
 * @remarks
 * The one place a point series and a level series are told apart for the
 * crosshair and the catalogue: everything downstream reads levels.
 */
const levelsOf = (series: ValueSeries): readonly Level.Level[] =>
  series.kind === 'points' ? PointSeries.toLevels(series) : series.levels

/**
 * The levels of {@link levelsOf} that start inside `window`, both ends
 * included, in series order — a point series' built only for the readings
 * there (`PointSeries.levelsWithin`).
 */
const levelsWithin = (series: ValueSeries, window: TimeDomain): readonly Level.Level[] =>
  series.kind === 'points'
    ? PointSeries.levelsWithin(series, window)
    : series.levels.filter((level) => contains(window, level.start.epochMillis))

/**
 * The level a crosshair reads off `series` at `time`.
 *
 * @returns `null` when the series has nothing to show there — see
 *   `PointSeries.levelAt` and `LevelSeries.levelAt` for the one difference
 *   (before its first reading a point series still names it)
 */
const levelAt = (series: ValueSeries, time: DateTime.Utc): Level.Level | null =>
  series.kind === 'points' ? PointSeries.levelAt(series, time) : LevelSeries.levelAt(series, time)

/** The earliest and latest of `instants`, or `null` when there are none. */
const extentOfInstants = (instants: readonly DateTime.Utc[]): TimeDomain | null => {
  const first = instants[0]
  if (first === undefined) return null
  let earliest = first
  let latest = first
  for (const instant of instants) {
    if (instant.epochMillis < earliest.epochMillis) earliest = instant
    if (instant.epochMillis > latest.epochMillis) latest = instant
  }
  return [earliest, latest]
}

/**
 * Every stated boundary of `series`: each level's start, and each end that is
 * not open; for a span series, each span's start and end.
 */
const boundariesOf = (series: Series): readonly DateTime.Utc[] =>
  series.kind === 'spans'
    ? series.spans.flatMap((span) => [span.start, span.end])
    : levelsOf(series).flatMap((level) =>
        level.end === null ? [level.start] : [level.start, level.end]
      )

/**
 * The instants `series` spans: the earliest boundary to the latest
 * ({@link boundariesOf}).
 *
 * @returns `null` when the series is empty
 *
 * @remarks
 * An open-ended level contributes only its start — it has no end to span to.
 */
const extentOf = (series: Series): TimeDomain | null => extentOfInstants(boundariesOf(series))

/**
 * The instants a set of series spans together: the earliest boundary of any
 * of them to the latest — what a chart drawing all of them over their own
 * extent spans.
 *
 * @returns `null` when every series is empty, or there are none
 *
 * @remarks
 * The same boundaries {@link extentOf} reads, pooled, so it equals the hull of
 * each non-empty series' own extent.
 */
const extentOfAll = (seriesList: readonly Series[]): TimeDomain | null =>
  extentOfInstants(seriesList.flatMap(boundariesOf))

/** How many readings, levels or spans `series` holds, by its kind. */
const sizeOf = (series: Series): number => {
  if (series.kind === 'points') return series.points.length
  if (series.kind === 'levels') return series.levels.length
  return series.spans.length
}

export {
  boundariesOf,
  extentOf,
  extentOfAll,
  isSpanSeries,
  isValueSeries,
  levelAt,
  levelsOf,
  levelsWithin,
  sizeOf,
}
export type { Series, ValueScale, ValueSeries }
