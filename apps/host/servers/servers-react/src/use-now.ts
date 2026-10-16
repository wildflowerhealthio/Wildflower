import { DateTime, Duration, Option } from 'effect'
import { useCallback } from 'react'

import { type Ticks, useLatestTick } from './use-latest-tick.ts'

/**
 * The time now, as of its latest tick, rendering again at each: ticks fall
 * `every` apart, on `until` and each whole `every` before it, and stop once
 * `until` passes. With no `until` it never ticks, and says the time as of
 * the render, to the whole `every`.
 *
 * @remarks
 * Between ticks the answer stays the same, as `useSyncExternalStore` needs
 * of its snapshot. As a tick falls on `until` itself and on each whole
 * `every` before it, the time left from the answer, rounded up to a whole
 * `every`, is the time left from the clock rounded the same way, and `until`
 * is seen to pass as it passes. The clock is `useLatestTick`'s, which
 * `useHasPassed` shares.
 */
const useNow = (
  every: Duration.DurationInput,
  until: Option.Option<DateTime.Utc>
): DateTime.Utc => {
  const everyMillis = Duration.toMillis(every)
  const untilMillis = until.pipe(Option.map(DateTime.toEpochMillis), Option.getOrNull)
  const ticksAt = useCallback(
    (nowMillis: number): Ticks => {
      const alignedTo = untilMillis ?? 0
      const latest = alignedTo + Math.floor((nowMillis - alignedTo) / everyMillis) * everyMillis
      return {
        latest,
        next: untilMillis !== null && latest < untilMillis ? latest + everyMillis : undefined,
      }
    },
    [everyMillis, untilMillis]
  )
  return DateTime.unsafeMake(useLatestTick(ticksAt))
}

export { useNow }
