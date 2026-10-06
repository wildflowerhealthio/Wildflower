import { Link } from '@tanstack/react-router'
import { DateTime, Duration } from 'effect'
import { formatRelativeTime } from 'kitchen-sink'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { ItemList, type ItemListItem } from 'react-tundraish'

import { REFUSED_STREAK_WINDOW, type ActivityCounts, type RefusedStreak } from '../activity-feed.ts'
import { accessLabelOf, type RequestAccess } from '../request-log.ts'
import styles from './RequestActivityFeed.module.css'

/**
 * One caller the activity feed renders as a row.
 *
 *   - `name` — who called: the client's name, its id, "Open" when no sign-in
 *     was needed, or "No client" when refused before a client was verified.
 *   - `location` — the address it called from.
 *   - `lastConnectionAt` — its latest request, shown as a relative time on the
 *     row's right edge ("now", "2 min ago").
 *   - `access` — how that request met the bearer gates. Drives the leading dot
 *     color, the detail line, and the danger tint on a refused row.
 */
interface ActivityEntry {
  readonly name: string
  readonly location: string
  readonly lastConnectionAt: DateTime.DateTime
  readonly access: RequestAccess
}

interface RequestActivityFeedProps {
  readonly entries: readonly ActivityEntry[]
  /** Every request the log holds, by `auth` case, for the summary line. */
  readonly counts: ActivityCounts
  /** Addresses refused often enough lately to warn about. */
  readonly streaks: readonly RefusedStreak[]
  /**
   * Override "now" for the relative-time formatter. Tests pin this so
   * the rendered "N min ago" values are deterministic; runtime callers
   * leave it undefined and the component reads `DateTime.unsafeNow()`.
   */
  readonly now?: DateTime.DateTime
  readonly className?: string
}

const DOT_MODIFIERS: Readonly<Record<RequestAccess['auth'], string | undefined>> = {
  authorized: styles['request-activity-feed__dot--authorized'],
  public: styles['request-activity-feed__dot--public'],
  refused: styles['request-activity-feed__dot--refused'],
}

const toItem = (entry: ActivityEntry, index: number, now: DateTime.DateTime): ItemListItem => ({
  id: `${index}-${entry.name}`,
  title: entry.name,
  subtitle: `${entry.location} · ${accessLabelOf(entry.access)}`,
  meta: formatRelativeTime(entry.lastConnectionAt, now),
  tone: entry.access.auth === 'refused' ? 'danger' : 'neutral',
  leading: (
    <span className={cn(styles['request-activity-feed__dot'], DOT_MODIFIERS[entry.access.auth])} />
  ),
})

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`

const describeCounts = (counts: ActivityCounts): string =>
  [
    plural(counts.authorized + counts.public + counts.refused, 'request', 'requests'),
    `${counts.authorized} signed in`,
    `${counts.public} no sign-in needed`,
    `${counts.refused} refused`,
  ].join(' · ')

/**
 * Recent-activity card — the callers seen most recently, a count of every
 * request the log holds by how it met the bearer gates, and a warning per
 * address refused often enough lately to look like credential guessing, each
 * linking to that address's refused requests in the log below.
 *
 * Each row reads as: a leading status dot, the caller's name + a
 * relative-time mark on the row's right edge, and a detail line
 * underneath. Refused rows tint the whole row danger so a single
 * failure stands out against an otherwise-quiet feed.
 */
const RequestActivityFeed = ({
  entries,
  counts,
  streaks,
  now,
  className,
}: RequestActivityFeedProps): JSX.Element => {
  const resolvedNow = now ?? DateTime.unsafeNow()
  const items = entries.map((entry, index) => toItem(entry, index, resolvedNow))

  return (
    <section className={cn(styles['request-activity-feed'], className)}>
      <div className={styles['request-activity-feed__header']}>
        <span className={styles['request-activity-feed__label']}>Recent activity</span>
      </div>
      <p className={styles['request-activity-feed__summary']}>{describeCounts(counts)}</p>
      {streaks.map((streak) => (
        <p key={streak.address} className={styles['request-activity-feed__warning']} role="alert">
          {plural(streak.count, 'refused request', 'refused requests')} from {streak.address} in the
          last {Duration.toMinutes(REFUSED_STREAK_WINDOW)} minutes — possible credential guessing.{' '}
          <Link
            className={styles['request-activity-feed__warning-link']}
            to="/settings/requests"
            search={{ address: streak.address, auth: 'refused' }}
          >
            Review
          </Link>
        </p>
      ))}
      {entries.length === 0 ? (
        <p className={styles['request-activity-feed__empty']}>
          No requests have come through the tunnel yet.
        </p>
      ) : (
        <ItemList items={items} />
      )}
    </section>
  )
}

export { RequestActivityFeed }
export type { ActivityEntry, RequestActivityFeedProps }
