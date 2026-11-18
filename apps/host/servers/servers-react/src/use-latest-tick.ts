import { DateTime } from 'effect'
import { useCallback, useSyncExternalStore } from 'react'

/** The longest delay `setTimeout` keeps: a longer one fires at once. */
const LONGEST_TIMEOUT_MILLIS = 2 ** 31 - 1

/** A clock's ticks as of an instant: its latest, and its next, if it ticks again. */
interface Ticks {
  readonly latest: number
  readonly next: number | undefined
}

/**
 * The latest of a clock's ticks, in epoch millis, rendering again at each:
 * `ticksAt` says, for the time now, which tick was the latest and when the
 * next falls, if any.
 *
 * @remarks
 * `ticksAt` must be stable (wrap it in `useCallback`) and its ticks only move
 * forward: once it has no next tick, the clock never ticks again, so it sets
 * no timer and hears nothing. While it does, one timer waits for the next
 * tick, in steps of `setTimeout`'s longest delay for one further off. A page
 * shown again reads the clock at once, since a phone suspending the app, or
 * a desktop sleeping, holds its timers back past their time.
 */
const useLatestTick = (ticksAt: (nowMillis: number) => Ticks): number => {
  const latestTick = useCallback(() => ticksAt(DateTime.unsafeNow().epochMillis).latest, [ticksAt])
  const subscribeToTicks = useCallback(
    (onTick: () => void): (() => void) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const waitForNextTick = (): void => {
        clearTimeout(timer)
        const now = DateTime.unsafeNow().epochMillis
        const { next } = ticksAt(now)
        if (next === undefined) return
        timer = setTimeout(
          () => {
            onTick()
            waitForNextTick()
          },
          Math.min(next - now, LONGEST_TIMEOUT_MILLIS)
        )
      }
      const onShown = (): void => {
        if (document.visibilityState !== 'visible') return
        onTick()
        waitForNextTick()
      }
      if (ticksAt(DateTime.unsafeNow().epochMillis).next === undefined) return () => undefined
      document.addEventListener('visibilitychange', onShown)
      waitForNextTick()
      return () => {
        clearTimeout(timer)
        document.removeEventListener('visibilitychange', onShown)
      }
    },
    [ticksAt]
  )
  return useSyncExternalStore(subscribeToTicks, latestTick)
}

export { useLatestTick }
export type { Ticks }
