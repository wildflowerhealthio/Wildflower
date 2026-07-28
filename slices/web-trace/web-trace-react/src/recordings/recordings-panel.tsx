import { useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { ErrorBanner, PageLoading } from 'react-tundraish'
import { traceResourceId, type TraceExchange } from 'web-trace-core'

import { ExchangeDetail } from '../exchanges/exchange-detail.tsx'
import { ExchangeList } from '../exchanges/exchange-list.tsx'
import { NO_FILTERS, type ExchangeFilters } from '../exchanges/filter-exchanges.ts'
import type { TraceExchangesQueryOptions } from '../queries/index.ts'
import { SessionsList } from '../sessions/sessions-list.tsx'
import { useTraceSessions } from '../sessions/use-trace-sessions.ts'
import styles from './recordings-panel.module.css'

/** Props for {@link RecordingsPanel}. */
interface RecordingsPanelProps {
  /**
   * Called when a row in the exchange list is activated, in addition to opening
   * the detail. Use it to mirror the selection into a host app's route.
   */
  readonly onSelectExchange?: (exchange: TraceExchange) => void
  /** Page size for the underlying read. */
  readonly queryOptions?: TraceExchangesQueryOptions
  readonly className?: string
}

/**
 * The recordings tab: the device's sessions, the exchanges of whichever one is
 * open, and the full detail of whichever exchange is open. Data comes from
 * {@link useTraceSessions}, which reads through router context — mount it inside
 * the host app's router and `QueryClientProvider`.
 *
 * @remarks
 * Three master/detail levels, each replacing the last with a control back.
 * Selection and filter state live here; filters reset per session, and an open
 * id that is no longer present falls back to the level above rather than
 * rendering an empty detail.
 */
const RecordingsPanel = ({
  onSelectExchange,
  queryOptions,
  className,
}: RecordingsPanelProps): JSX.Element => {
  const { sessions, unreadableCount, isPending, hasMore, isLoadingMore, loadMore, error } =
    useTraceSessions(queryOptions)
  const [openSessionId, setOpenSessionId] = useState<string | null>(null)
  const [openExchangeId, setOpenExchangeId] = useState<string | null>(null)
  const [filters, setFilters] = useState<ExchangeFilters>(NO_FILTERS)

  const openSession = sessions.find((session) => session.sessionId === openSessionId)
  const openExchange = openSession?.exchanges.find(
    (exchange) => traceResourceId(exchange) === openExchangeId
  )

  const sessionHeader = (title: string, onBack: () => void): JSX.Element => (
    <div className={styles['recordings__session-header']}>
      <button type="button" className="button-3 outline" onClick={onBack}>
        {openExchange === undefined ? 'All recordings' : 'Back to exchanges'}
      </button>
      <p className={cn(styles['recordings__session-id'], 'text-label-3')}>{title}</p>
    </div>
  )

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
            setOpenExchangeId(null)
            setFilters(NO_FILTERS)
          }}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          onLoadMore={loadMore}
          unreadableCount={unreadableCount}
        />
      )
    }
    if (openExchange !== undefined) {
      return (
        <>
          {sessionHeader(openExchange.url, (): void => {
            setOpenExchangeId(null)
          })}
          <ExchangeDetail exchange={openExchange} />
        </>
      )
    }
    return (
      <>
        {sessionHeader(openSession.sessionId, (): void => {
          setOpenSessionId(null)
        })}
        <ExchangeList
          exchanges={openSession.exchanges}
          filters={filters}
          onFiltersChange={setFilters}
          onSelectExchange={(exchange: TraceExchange): void => {
            setOpenExchangeId(traceResourceId(exchange))
            onSelectExchange?.(exchange)
          }}
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
