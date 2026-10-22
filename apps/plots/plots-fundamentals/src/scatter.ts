import type { DateTime } from 'effect'

import type * as Level from './level.ts'
import * as Series from './series.ts'
import type * as TimeDomain from './time-domain.ts'

/** One X reading and the Y value in effect at its time. */
interface Pair {
  readonly time: DateTime.Utc
  /** The X series' level starting at `time`. */
  readonly x: Level.Level
  /** The Y series' level in effect at `time`. */
  readonly y: Level.Level
}

/**
 * One value series plotted against another: each X reading paired with the
 * Y value at its time.
 */
interface Scatter {
  /** In X's reading order. */
  readonly pairs: readonly Pair[]
  /**
   * The X readings in the window with no Y value at their time — before a
   * point series Y's first reading, in a gap in a level series Y, or with an
   * empty Y — so the plot can say what it left out.
   */
  readonly unpairedCount: number
}

/**
 * The level in effect on `y` at `time`, or `null` when Y wasn't measured by
 * then: `Series.levelAt`, except that before a point series' first reading
 * there is none.
 */
const yLevelAt = (y: Series.ValueSeries, time: DateTime.Utc): Level.Level | null => {
  if (y.kind === 'points' && (y.points[0]?.time.epochMillis ?? Infinity) > time.epochMillis) {
    return null
  }
  return Series.levelAt(y, time)
}

/**
 * Pair `x`'s readings inside `window` with `y`'s value at each one's time.
 *
 * @remarks
 * An X reading is one of its levels' starts (`Series.levelsWithin`), so a level
 * series' readings are its levels. Y is read as the chart's crosshair reads it
 * (`Series.levelAt`) — a point series Y's last reading held from then on, a
 * level series Y naming nothing in a gap — except that an X reading before a
 * point series Y's first reading is unpaired, where the crosshair would still
 * name that first reading.
 */
const of = (
  x: Series.ValueSeries,
  y: Series.ValueSeries,
  window: TimeDomain.TimeDomain
): Scatter => {
  const pairs: Pair[] = []
  let unpairedCount = 0
  for (const level of Series.levelsWithin(x, window)) {
    const yLevel = yLevelAt(y, level.start)
    if (yLevel === null) unpairedCount += 1
    else pairs.push({ time: level.start, x: level, y: yLevel })
  }
  return { pairs, unpairedCount }
}

export { of }
export type { Pair, Scatter }
