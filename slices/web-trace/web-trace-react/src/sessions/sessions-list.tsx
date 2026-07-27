import { DateTime } from 'effect'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Chip, ItemList, StatusBadge, type ItemListItem } from 'react-tundraish'

import type { TraceSession } from './group-sessions.ts'
import styles from './sessions-list.module.css'

/** Props for {@link SessionsList}. */
interface SessionsListProps {
  /** The sessions to list, in the order they should render. */
  readonly sessions: readonly TraceSession[]
  /** Called with a session id when its row is activated. */
  readonly onSelectSession: (sessionId: string) => void
  /** Whether the server reported further pages, which makes every count a lower bound. */
  readonly hasMore: boolean
  /** Whether a further page is in flight. */
  readonly isLoadingMore: boolean
  /** Fetches the next page. */
  readonly onLoadMore: () => void
  /** How many trace resources could not be decoded across the pages read so far. */
  readonly unreadableCount: number
  readonly className?: string
}

/** The session's activity window, as a local-time range for a row's subtitle. */
const describeWindow = (session: TraceSession): string => {
  const first = new Date(DateTime.toEpochMillis(session.firstActivityAt)).toLocaleString()
  const last = new Date(DateTime.toEpochMillis(session.lastActivityAt)).toLocaleString()
  return first === last ? first : `${first} – ${last}`
}

/**
 * `1 exchange` / `N exchanges`, or `N+ exchanges` while the count is a lower
 * bound.
 *
 * @remarks
 * The singular applies only to an exact count of one. `1+` means *at least*
 * one, so it takes the plural noun — `1+ exchange` would read as a promise the
 * number cannot keep.
 */
const describeCount = (count: number, hasMore: boolean): string => {
  const noun = count === 1 && !hasMore ? 'exchange' : 'exchanges'
  return hasMore ? `${count}+ ${noun}` : `${count} ${noun}`
}

/**
 * The recordings tab's session list: one row per recording session, most
 * recently active first, with the hosts it talked to and how many exchanges it
 * holds.
 *
 * @remarks
 * While `hasMore` is set the counts are lower bounds and the rows say so
 * (`12+ exchanges`), and `unreadableCount` names the resources that failed to
 * decode. Both exist so a partial list never reads as a complete one — see the
 * package `AGENTS.md` for why a session's count is only exact once paging ends.
 */
const SessionsList = ({
  sessions,
  onSelectSession,
  hasMore,
  isLoadingMore,
  onLoadMore,
  unreadableCount,
  className,
}: SessionsListProps): JSX.Element => {
  const items: readonly ItemListItem[] = sessions.map((session) => ({
    id: session.sessionId,
    title: session.sessionId,
    subtitle: session.hosts.length === 0 ? describeWindow(session) : session.hosts.join(', '),
    meta: describeWindow(session),
    badge: <Chip>{describeCount(session.exchanges.length, hasMore)}</Chip>,
    onClick: (): void => {
      onSelectSession(session.sessionId)
    },
  }))

  return (
    <div className={cn(styles['sessions'], className)}>
      {unreadableCount > 0 ? (
        <p className={cn(styles['sessions__notice'], 'text-body-3')}>
          <StatusBadge tone="warning">
            {unreadableCount === 1
              ? '1 recording could not be read'
              : `${unreadableCount} recordings could not be read`}
          </StatusBadge>
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className={cn(styles['sessions__empty'], 'text-body-2')}>
          No recordings on this device.
        </p>
      ) : (
        <ItemList items={items} />
      )}

      {hasMore ? (
        <button
          type="button"
          className={cn(styles['sessions__more'], 'button-3 outline')}
          disabled={isLoadingMore}
          onClick={onLoadMore}
        >
          {isLoadingMore ? 'Loading…' : 'Load more recordings'}
        </button>
      ) : null}
    </div>
  )
}

export { SessionsList, type SessionsListProps }
