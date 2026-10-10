import { DateTime, Option } from 'effect'
import { useEffect, useReducer } from 'react'

/** The longest delay `setTimeout` keeps: a longer one fires at once. */
const LONGEST_TIMEOUT_MILLIS = 2 ** 31 - 1

/**
 * Whether `instant` has passed, rendering again once it does: one timer, set
 * for `instant`, while it is ahead; none once it has passed, or with no
 * instant.
 *
 * @remarks
 * An instant further off than `setTimeout` can wait is reached in steps of
 * its longest delay, one timer at a time.
 */
const useHasPassed = (instant: Option.Option<DateTime.Utc>): boolean => {
  const at = instant.pipe(Option.map(DateTime.toEpochMillis), Option.getOrNull)
  const [, renderAgain] = useReducer((renders: number) => renders + 1, 0)
  const hasPassed = at !== null && at <= DateTime.unsafeNow().epochMillis
  useEffect(() => {
    if (at === null || hasPassed) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const waitUntilPassed = (): void => {
      const remaining = at - DateTime.unsafeNow().epochMillis
      if (remaining <= 0) {
        renderAgain()
        return
      }
      timer = setTimeout(waitUntilPassed, Math.min(remaining, LONGEST_TIMEOUT_MILLIS))
    }
    waitUntilPassed()
    return () => {
      clearTimeout(timer)
    }
  }, [at, hasPassed])
  return hasPassed
}

export { useHasPassed }
