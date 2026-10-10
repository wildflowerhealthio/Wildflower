import type { DateTime } from 'effect'

/**
 * A value held over an interval: in effect from `start` until `end`, both
 * ends included, or indefinitely while `end` is `null`.
 *
 * @remarks
 * The one shape a crosshair reads and snaps to. A reading taken at an instant
 * is held until the next reading replaces it (`PointSeries.toLevels`); a value
 * stated over a span, such as a dose, is a level as it stands.
 *
 * - `low` / `high`: the band around the value (a reference range), absent
 *   rather than `null` when there was none.
 * - `note`: a short qualifier the domain supplies for a readout to show
 *   beside the value (`per day`), so a renderer never reads domain fields.
 */
interface Level {
  readonly start: DateTime.Utc
  readonly end: DateTime.Utc | null
  readonly value: number
  readonly low?: number
  readonly high?: number
  readonly note?: string
}

/**
 * Whether `level` covers the instant `epochMillis` — started at or before it,
 * and not ended before it.
 */
const covers = (level: Level, epochMillis: number): boolean =>
  level.start.epochMillis <= epochMillis &&
  (level.end === null || level.end.epochMillis >= epochMillis)

/**
 * The level in effect at `time`.
 *
 * @param levels - Sorted ascending by `start`
 * @returns The latest-starting level that covers `time`, or `null` when none
 *   does — outside every level nothing was in effect, which is an answer
 *   rather than a reason to fall back to the nearest one
 *
 * @remarks
 * Binary search for the last level started by `time`, then a walk back to the
 * first of those that still covers it: levels that do not overlap (every
 * `PointSeries`) answer at the first step, and only overlapping ones pay for
 * the walk. This runs on every pointer move.
 */
const inEffectAt = <L extends Level>(levels: readonly L[], time: DateTime.Utc): L | null => {
  const target = time.epochMillis
  let low = 0
  let high = levels.length - 1
  let lastStarted = -1
  while (low <= high) {
    const middle = (low + high) >>> 1
    if (levels[middle].start.epochMillis <= target) {
      lastStarted = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  for (let index = lastStarted; index >= 0; index -= 1) {
    if (covers(levels[index], target)) return levels[index]
  }
  return null
}

export { inEffectAt }
export type { Level }
