import { type DateTime, Option } from 'effect'
import { useCallback } from 'react'

import { type Ticks, useLatestTick } from './use-latest-tick.ts'

/** The tick of a clock whose instant is ahead, or that has none. */
const NOT_PASSED = 0
/** The tick of a clock whose instant has passed. */
const PASSED = 1

/**
 * Whether `instant` has passed, rendering again once it does: one timer, set
 * for `instant`, while it is ahead; none once it has passed, or with no
 * instant.
 *
 * @remarks
 * The clock is `useLatestTick`'s, which `useNow` shares: it reads the time
 * again as the page is shown, and reaches an instant further off than
 * `setTimeout` can wait in steps of its longest delay.
 */
const useHasPassed = (instant: Option.Option<DateTime.Utc>): boolean => {
  const at = instant.pipe(
    Option.map((utc) => utc.epochMillis),
    Option.getOrNull
  )
  const ticksAt = useCallback(
    (nowMillis: number): Ticks => {
      if (at === null) return { latest: NOT_PASSED, next: undefined }
      return at <= nowMillis
        ? { latest: PASSED, next: undefined }
        : { latest: NOT_PASSED, next: at }
    },
    [at]
  )
  return useLatestTick(ticksAt) === PASSED
}

export { useHasPassed }
