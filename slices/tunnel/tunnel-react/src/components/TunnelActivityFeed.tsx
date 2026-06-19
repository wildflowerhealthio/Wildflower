import { Link } from '@tanstack/react-router'
import { DateTime } from 'effect'
import { formatRelativeTime } from 'kitchen-sink'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { ItemList, type ItemListItem } from 'react-tundraish'

import styles from './TunnelActivityFeed.module.css'

/**
 * A single connection event the activity feed renders as one row.
 *
 *   - `name` — the connecting agent (an app name, "Unknown client").
 *   - `location` — where it came from (a device label, an IP).
 *   - `lastConnectionAt` — the moment shown as a relative time on the
 *     row's right edge ("now", "2 min ago"). Effect `DateTime`, so
 *     the slice stays time-zone aware once a real source replaces the
 *     stubbed entries.
 *   - `message` — optional detail line addendum, used for the failure
 *     reason on blocked rows ("not authorized").
 *   - `state` — `active` (connection allowed) or `error` (blocked /
 *     denied). Drives the leading dot color, the row tint, and the
 *     meta-line prefix.
 */
interface ActivityEntry {
  readonly name: string
  readonly location: string
  readonly lastConnectionAt: DateTime.DateTime
  readonly message?: string
  readonly state: 'active' | 'error'
}

interface TunnelActivityFeedProps {
  readonly entries: readonly ActivityEntry[]
  /**
   * Override "now" for the relative-time formatter. Tests pin this so
   * the rendered "N min ago" values are deterministic; runtime callers
   * leave it undefined and the component reads `DateTime.unsafeNow()`.
   */
  readonly now?: DateTime.DateTime
  readonly className?: string
  /**
   * Optional destination for the "View all activity" footer link. The
   * full activity log is a future screen — leaving the URL stubbed
   * means the link still renders + navigates (to a 404 today) without
   * fabricating a typed route reference. Defaults to a stable
   * placeholder so consumers don't have to thread it.
   */
  readonly viewAllHref?: string
}

const buildSubtitle = (entry: ActivityEntry): string =>
  entry.message !== undefined ? `${entry.location} · ${entry.message}` : entry.location

const buildMeta = (entry: ActivityEntry, now: DateTime.DateTime): string => {
  const time = formatRelativeTime(entry.lastConnectionAt, now)
  return entry.state === 'error' ? `blocked · ${time}` : time
}

const toItem = (entry: ActivityEntry, index: number, now: DateTime.DateTime): ItemListItem => ({
  id: `${index}-${entry.name}`,
  title: entry.name,
  subtitle: buildSubtitle(entry),
  meta: buildMeta(entry, now),
  tone: entry.state === 'error' ? 'danger' : 'neutral',
  leading: (
    <span
      className={cn(
        styles['dot'],
        entry.state === 'error' ? styles['dot--error'] : styles['dot--active']
      )}
    />
  ),
})

/**
 * Recent-activity card — a list of the most recent connection events
 * (allowed + blocked). Renders only when the tunnel is open; the
 * parent route gates this so the off-state's educational explainer
 * stands in.
 *
 * Each row reads as: a leading status dot, the agent's name + a
 * relative-time mark on the row's right edge, and a detail line
 * underneath. Blocked rows tint the whole row danger so a single
 * failure stands out against an otherwise-quiet feed.
 */
const TunnelActivityFeed = ({
  entries,
  now,
  className,
  viewAllHref = '/settings/tunnel/activity',
}: TunnelActivityFeedProps): JSX.Element => {
  const resolvedNow = now ?? DateTime.unsafeNow()
  const items = entries.map((entry, index) => toItem(entry, index, resolvedNow))
  const blockedCount = entries.filter((entry) => entry.state === 'error').length

  return (
    <section className={cn(styles['feed'], className)}>
      <div className={styles['feed__header']}>
        <span className={styles['feed__label']}>Recent activity</span>
        <span className={styles['feed__live']}>Live</span>
      </div>
      <p className={styles['feed__summary']}>
        {entries.length} {entries.length === 1 ? 'request' : 'requests'} today · {blockedCount}{' '}
        blocked
      </p>
      <ItemList items={items} />
      <Link className={styles['feed__footer']} to={viewAllHref}>
        View all activity ›
      </Link>
    </section>
  )
}

export { TunnelActivityFeed }
export type { ActivityEntry, TunnelActivityFeedProps }
