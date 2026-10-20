import { DateTime, Duration } from 'effect'

/**
 * Bucket boundaries — the cutoffs the activity feed's "ago" copy
 * agrees about. Authored as `Duration`s so the comparisons read like
 * the design intent ("under a minute → 'now'") rather than raw
 * millisecond constants.
 */
const ONE_MINUTE = Duration.minutes(1)
const ONE_HOUR = Duration.hours(1)
const ONE_DAY = Duration.days(1)
const TWO_WEEKS = Duration.days(14)
const NINE_WEEKS = Duration.days(63)

/** The average month, in days, that a gap of 9 weeks or more is counted in. */
const DAYS_PER_MONTH = 30.44

/**
 * Pure relative-time formatter. Returns a short "ago"-style string
 * describing how far `from` is in the past relative to `now`:
 *
 *   - under 1 min → `now`
 *   - under 1 hr  → `N min ago`
 *   - under 1 day → `N hr ago`
 *   - under 14 days → `N day ago` / `N days ago`
 *   - under 63 days → `N weeks ago`, whole weeks, so 2 to 8
 *   - otherwise   → `N months ago`, whole 30.44-day months, so from 2;
 *     there is no years bucket (365 days reads `11 months ago`)
 *
 * Future `from` values (clock skew, or a row authored just ahead of
 * the wall clock) clamp to `now` rather than rendering a "−5 min ago"
 * artifact — the activity feed never wants to read as "this happened
 * in the future".
 *
 * Effect's `Duration.format` exists but produces compound output
 * (`"1h 23m"`); the feed wants a single coarsest-bucket phrase, so
 * this stays a small custom formatter rather than borrowing that one.
 */
const formatRelativeTime = (from: DateTime.DateTime, now: DateTime.DateTime): string => {
  if (DateTime.greaterThan(from, now)) return 'now'
  const diff = DateTime.distanceDuration(from, now)
  if (Duration.lessThan(diff, ONE_MINUTE)) return 'now'
  if (Duration.lessThan(diff, ONE_HOUR)) {
    return `${Math.floor(Duration.toMinutes(diff))} min ago`
  }
  if (Duration.lessThan(diff, ONE_DAY)) {
    return `${Math.floor(Duration.toHours(diff))} hr ago`
  }
  const days = Duration.toDays(diff)
  if (Duration.lessThan(diff, TWO_WEEKS)) {
    const wholeDays = Math.floor(days)
    return wholeDays === 1 ? '1 day ago' : `${wholeDays} days ago`
  }
  if (Duration.lessThan(diff, NINE_WEEKS)) {
    return `${Math.floor(Duration.toWeeks(diff))} weeks ago`
  }
  return `${Math.floor(days / DAYS_PER_MONTH)} months ago`
}

export { formatRelativeTime }
