import { DateTime } from 'effect'

// Round a whole-day magnitude to a coarse (count, unit): days up to ~10, then
// weeks up to ~8 weeks, then months.
const coarsen = (days: number): readonly [number, string] => {
  if (days <= 10) return [days, 'day']
  if (days <= 56) return [Math.floor(days / 7), 'week']
  return [Math.floor(days / 30), 'month']
}

/**
 * A coarse, human-readable distance from `nowMillis` (epoch ms) to an ISO
 * instant, for a next-fill hint: `"today"`, `"in 3 days"`, `"in 2 weeks"`,
 * `"in 5 months"` (and the past `"… ago"` forms). Rounds to whole days, then
 * collapses to weeks past ~10 days and months past ~8 weeks — deliberately
 * imprecise, matching how a fill reminder reads.
 */
const describeDayFromNow = (iso: string, nowMillis: number): string => {
  const target = DateTime.toEpochMillis(DateTime.unsafeMake(iso))
  const days = Math.round((target - nowMillis) / 86_400_000)
  if (days === 0) return 'today'
  const [count, unit] = coarsen(Math.abs(days))
  const phrase = `${count} ${count === 1 ? unit : `${unit}s`}`
  return days > 0 ? `in ${phrase}` : `${phrase} ago`
}

export { coarsen, describeDayFromNow }
