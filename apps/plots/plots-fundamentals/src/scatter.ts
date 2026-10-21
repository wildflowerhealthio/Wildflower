import type { DateTime } from 'effect'

import type * as Level from './level.ts'
import * as Series from './series.ts'
import * as TimeDomain from './time-domain.ts'

/** One X reading and the Y value in effect at its time. */
interface Pair {
  readonly time: DateTime.Utc
  /** The X series' level starting at `time`. */
  readonly x: Level.Level
  /** The level `Series.levelAt` reads off the Y series at `time`. */
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
   * The X readings in the window with no Y value at their time — a gap in a
   * level series, or an empty Y — so the plot can say what it left out.
   */
  readonly unpairedCount: number
}

/**
 * Pair `x`'s readings inside `window` with `y`'s value at each one's time.
 *
 * @remarks
 * An X reading is one of its levels' starts (`Series.levelsOf`), so a level
 * series' readings are its levels. Y is read with `Series.levelAt` — the
 * value the chart's crosshair reads at that instant — so a point series Y
 * still names its first reading before it begins, and a level series Y names
 * nothing in a gap.
 */
const of = (
  x: Series.ValueSeries,
  y: Series.ValueSeries,
  window: TimeDomain.TimeDomain
): Scatter => {
  const pairs: Pair[] = []
  let unpairedCount = 0
  for (const level of Series.levelsOf(x)) {
    if (!TimeDomain.contains(window, level.start.epochMillis)) continue
    const yLevel = Series.levelAt(y, level.start)
    if (yLevel === null) unpairedCount += 1
    else pairs.push({ time: level.start, x: level, y: yLevel })
  }
  return { pairs, unpairedCount }
}

export { of }
export type { Pair, Scatter }
