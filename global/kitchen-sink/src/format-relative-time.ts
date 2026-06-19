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

/**
 * Pure relative-time formatter. Returns a short "ago"-style string
 * describing how far `from` is in the past relative to `now`:
 *
 *   - under 1 min → `now`
 *   - under 1 hr  → `N min ago`
 *   - under 1 day → `N hr ago`
 *   - otherwise   → `N day ago` / `N days ago`
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
  const days = Math.floor(Duration.toDays(diff))
  return days === 1 ? '1 day ago' : `${days} days ago`
}

export { formatRelativeTime }
