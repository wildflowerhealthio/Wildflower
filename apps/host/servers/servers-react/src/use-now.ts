import { DateTime, Duration, Option } from 'effect'
import { useCallback, useSyncExternalStore } from 'react'

/**
 * The time now, as of its latest tick, rendering again at each: ticks fall
 * `every` apart, on `alignedTo` and each whole `every` either side of it,
 * or on the epoch's with no instant.
 *
 * @remarks
 * Between ticks the answer stays the same, as `useSyncExternalStore` needs
 * of its snapshot. Aligned to a deadline, a tick falls on the deadline
 * itself and on each whole `every` before it: the time left from the answer,
 * rounded up to a whole `every`, is the time left from the clock rounded the
 * same way, and the deadline is seen to pass as it passes.
 */
const useNow = (
  every: Duration.DurationInput,
  alignedTo: Option.Option<DateTime.Utc>
): DateTime.Utc => {
  const everyMillis = Duration.toMillis(every)
  const alignedToMillis = alignedTo.pipe(
    Option.map(DateTime.toEpochMillis),
    Option.getOrElse(() => 0)
  )
  const latestTick = useCallback((): number => {
    const sinceAligned = DateTime.unsafeNow().epochMillis - alignedToMillis
    return alignedToMillis + Math.floor(sinceAligned / everyMillis) * everyMillis
  }, [everyMillis, alignedToMillis])
  const subscribeToTicks = useCallback(
    (onTick: () => void): (() => void) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const waitForNextTick = (): void => {
        const untilNextTick = latestTick() + everyMillis - DateTime.unsafeNow().epochMillis
        timer = setTimeout(() => {
          onTick()
          waitForNextTick()
        }, untilNextTick)
      }
      waitForNextTick()
      return () => {
        clearTimeout(timer)
      }
    },
    [latestTick, everyMillis]
  )
  return DateTime.unsafeMake(useSyncExternalStore(subscribeToTicks, latestTick))
}

export { useNow }
