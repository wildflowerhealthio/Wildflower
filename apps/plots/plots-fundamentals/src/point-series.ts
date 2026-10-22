import type { DateTime } from 'effect'

import { partitionPoint } from '@wildflowerhealthio/kitchen-sink'

import type * as Level from './level.ts'
import type { ValueScale } from './series.ts'
import type { TimeDomain } from './time-domain.ts'

/**
 * How a line is drawn between two readings: straight from one to the next, or
 * held flat until the next one and then stepped.
 */
type Interpolation = 'linear' | 'step'

/**
 * One reading at an instant, optionally bracketed by a band. `low` / `high`
 * and `note` are absent rather than `null` when there are none.
 */
interface Point {
  readonly time: DateTime.Utc
  readonly value: number
  readonly low?: number
  readonly high?: number
  readonly note?: string
}

/**
 * A line of readings taken at instants.
 *
 * - `id`: opaque and stable — the string a selection, a URL and a React key
 *   carry. Only the domain source that minted it can read it.
 * - `unit`: part of what the series is, not a label: one code in two units is
 *   two series.
 * - `points`: sorted ascending by `time`; equal times keep their source order.
 */
interface PointSeries {
  readonly kind: 'points'
  readonly id: string
  readonly label: string
  readonly unit: string | null
  readonly valueScale: ValueScale
  readonly interpolation: Interpolation
  readonly points: readonly Point[]
}

/** The level a reading holds from its own time until `end`. */
const levelOf = (point: Point, end: DateTime.Utc | null): Level.Level => ({
  start: point.time,
  end,
  value: point.value,
  ...(point.low === undefined ? {} : { low: point.low }),
  ...(point.high === undefined ? {} : { high: point.high }),
  ...(point.note === undefined ? {} : { note: point.note }),
})

/**
 * Read a series as levels: each reading held until the next one is taken, and
 * the last one held indefinitely (`end: null`).
 *
 * @returns One level per point, in point order, each ending exactly where the
 *   next starts — so they never overlap and a crosshair's stops are exactly
 *   the reading times
 *
 * @remarks
 * The last reading is open-ended because it is the latest thing known: a
 * crosshair after it still reads it.
 */
const toLevels = (series: PointSeries): readonly Level.Level[] =>
  series.points.map((point, index) => levelOf(point, series.points[index + 1]?.time ?? null))

/** Whether a reading is before `millis`, for {@link partitionPoint} to find the first reading at or past it. */
const isBefore =
  (millis: number) =>
  (point: Point): boolean =>
    point.time.epochMillis < millis

/** Whether a reading is at or before `millis`, for {@link partitionPoint} to find the first reading past it. */
const isAtOrBefore =
  (millis: number) =>
  (point: Point): boolean =>
    point.time.epochMillis <= millis

/**
 * The level a crosshair reads off `series` at `time` — the same level
 * {@link toLevels} holds there, found without building them all.
 *
 * @returns The level of the last reading at or before `time`; before the first
 *   reading, the first reading's level; `null` for an empty series
 *
 * @remarks
 * The fallback before the first reading is deliberate: a crosshair resting
 * left of this series (on another series' reading) still names where this one
 * begins, rather than going blank. Binary search, since this runs on every
 * pointer move over a series that can hold thousands of readings.
 */
const levelAt = (series: PointSeries, time: DateTime.Utc): Level.Level | null => {
  const points = series.points
  if (points.length === 0) return null
  const found = Math.max(partitionPoint(points, isAtOrBefore(time.epochMillis)) - 1, 0)
  return levelOf(points[found], points[found + 1]?.time ?? null)
}

/**
 * The levels {@link toLevels} holds that start inside `window`, both ends
 * included — built only for the readings there.
 *
 * @remarks
 * The last level inside the window still ends at the next reading, even when
 * that reading is past the window. Binary search for the window's ends, since
 * the table and the scatter read a window of a series that can hold
 * thousands of readings.
 */
const levelsWithin = (series: PointSeries, window: TimeDomain): readonly Level.Level[] => {
  const points = series.points
  const from = partitionPoint(points, isBefore(window[0].epochMillis))
  const to = partitionPoint(points, isAtOrBefore(window[1].epochMillis))
  const levels: Level.Level[] = []
  for (let index = from; index < to; index += 1) {
    levels.push(levelOf(points[index], points[index + 1]?.time ?? null))
  }
  return levels
}

export { levelAt, levelsWithin, toLevels }
export type { Interpolation, Point, PointSeries }
