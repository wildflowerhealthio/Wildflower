import type { DateTime } from 'effect'

import * as LevelSeries from './level-series.ts'
import type * as Level from './level.ts'
import * as PointSeries from './point-series.ts'
import type { TimeDomain } from './time-domain.ts'

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

/** Anything the chart plots; discriminate on `kind`. */
type Series = PointSeries.PointSeries | LevelSeries.LevelSeries

/**
 * `series` as levels — a point series' readings each held until the next one
 * (`PointSeries.toLevels`), a level series' own levels.
 *
 * @remarks
 * The one place a point series and a level series are told apart for the
 * crosshair and the catalogue: everything downstream reads levels.
 */
const levelsOf = (series: Series): readonly Level.Level[] =>
  series.kind === 'points' ? PointSeries.toLevels(series) : series.levels

/**
 * The level a crosshair reads off `series` at `time`.
 *
 * @returns `null` when the series has nothing to show there — see
 *   `PointSeries.levelAt` and `LevelSeries.levelAt` for the one difference
 *   (before its first reading a point series still names it)
 */
const levelAt = (series: Series, time: DateTime.Utc): Level.Level | null =>
  series.kind === 'points' ? PointSeries.levelAt(series, time) : LevelSeries.levelAt(series, time)

/**
 * The instants `series` spans: the earliest level start to the latest stated
 * boundary.
 *
 * @returns `null` when the series is empty
 *
 * @remarks
 * An open-ended level contributes only its start — it has no end to span to.
 */
const extentOf = (series: Series): TimeDomain | null => {
  const boundaries = levelsOf(series).flatMap((level) =>
    level.end === null ? [level.start] : [level.start, level.end]
  )
  const first = boundaries[0]
  if (first === undefined) return null
  let earliest = first
  let latest = first
  for (const boundary of boundaries) {
    if (boundary.epochMillis < earliest.epochMillis) earliest = boundary
    if (boundary.epochMillis > latest.epochMillis) latest = boundary
  }
  return [earliest, latest]
}

/** How many readings (for a point series) or levels (for a level series) `series` holds. */
const sizeOf = (series: Series): number =>
  series.kind === 'points' ? series.points.length : series.levels.length

export { extentOf, levelAt, levelsOf, sizeOf }
export type { Series, ValueScale }
