import { useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { ErrorBanner, PageLoading } from 'react-tundraish'
import type { TraceExchange } from 'web-trace-core'

import { ExchangeList } from '../exchanges/exchange-list.tsx'
import { NO_FILTERS, type ExchangeFilters } from '../exchanges/filter-exchanges.ts'
import type { TraceExchangesQueryOptions } from '../queries/index.ts'
import { SessionsList } from '../sessions/sessions-list.tsx'
import { useTraceSessions } from '../sessions/use-trace-sessions.ts'
import styles from './recordings-panel.module.css'

/** Props for {@link RecordingsPanel}. */
interface RecordingsPanelProps {
  /**
   * Called when a row in the exchange list is activated.
   *
   * @remarks
   * The panel does not render an exchange's detail itself — the host app owns
   * that surface. Omit it to leave rows inert.
   */
  readonly onSelectExchange?: (exchange: TraceExchange) => void
  /** Page size for the underlying read. */
  readonly queryOptions?: TraceExchangesQueryOptions
  readonly className?: string
}

/**
 * The recordings tab: the device's sessions, and the exchanges of whichever one
 * is open. Data comes from {@link useTraceSessions}, which reads through router
 * context — mount it inside the host app's router and `QueryClientProvider`.
 *
 * @remarks
 * Master/detail: the sessions list is replaced by the open session's exchanges,
 * with a control back. Selection and filter state live here, and filters reset
 * per session. An open session id that is no longer among the grouped sessions
 * falls back to the list rather than rendering an empty detail.
 */
const RecordingsPanel = ({
  onSelectExchange,
  queryOptions,
  className,
}: RecordingsPanelProps): JSX.Element => {
  const { sessions, unreadableCount, isPending, hasMore, isLoadingMore, loadMore, error } =
    useTraceSessions(queryOptions)
  const [openSessionId, setOpenSessionId] = useState<string | null>(null)
  const [filters, setFilters] = useState<ExchangeFilters>(NO_FILTERS)

  const openSession = sessions.find((session) => session.sessionId === openSessionId)

  const body = ((): JSX.Element | null => {
    if (isPending) return <PageLoading message="Loading recordings…" />
    // A failed read that produced nothing says nothing: "no recordings on this
    // device" would be a claim about the device, and what actually happened is
    // that the device was not successfully asked. The banner above is the whole
    // answer. A read that failed only on a later page still lists what arrived.
    if (error !== null && sessions.length === 0) return null
    if (openSession === undefined) {
      return (
        <SessionsList
          sessions={sessions}
          onSelectSession={(sessionId: string): void => {
            setOpenSessionId(sessionId)
            setFilters(NO_FILTERS)
          }}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          onLoadMore={loadMore}
          unreadableCount={unreadableCount}
        />
      )
    }
    return (
      <>
        <div className={styles['recordings__session-header']}>
          <button
            type="button"
            className="button-3 outline"
            onClick={(): void => {
              setOpenSessionId(null)
            }}
          >
            All recordings
          </button>
          <p className={cn(styles['recordings__session-id'], 'text-label-3')}>
            {openSession.sessionId}
          </p>
        </div>
        <ExchangeList
          exchanges={openSession.exchanges}
          filters={filters}
          onFiltersChange={setFilters}
          onSelectExchange={onSelectExchange ?? ((): void => {})}
        />
      </>
    )
  })()

  return (
    <div className={cn(styles['recordings'], className)}>
      <ErrorBanner error={error} />
      {body}
    </div>
  )
}

export { RecordingsPanel, type RecordingsPanelProps }
