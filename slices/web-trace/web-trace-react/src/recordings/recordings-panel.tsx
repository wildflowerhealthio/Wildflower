import { useMemo, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { ErrorBanner, PageLoading } from 'react-tundraish'
import { traceResourceId, type TraceExchange } from 'web-trace-core'

import { ExchangeDetail } from '../exchanges/exchange-detail.tsx'
import { ExchangeList } from '../exchanges/exchange-list.tsx'
import { filterExchanges, NO_FILTERS, type ExchangeFilters } from '../exchanges/filter-exchanges.ts'
import { ExportPanel } from '../export/export-panel.tsx'
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
 * The header above every level below the sessions list: the control back, and
 * what is currently open.
 *
 * @param title - What the open level is showing
 * @param backLabel - Where the control goes — one level up, always
 * @param onBack - Closes the current level
 * @returns The header row
 */
const sessionHeader = (title: string, backLabel: string, onBack: () => void): JSX.Element => (
  <div className={styles['recordings__session-header']}>
    <button type="button" className="button-3 outline" onClick={onBack}>
      {backLabel}
    </button>
    <p className={cn(styles['recordings__session-id'], 'text-label-3')}>{title}</p>
  </div>
)

/**
 * The recordings tab: the device's sessions, the exchanges of whichever one is
 * open, the full detail of whichever exchange is open, and the export flow for
 * whichever exchanges the filters currently show. Data comes from
 * {@link useTraceSessions}, which reads through router context — mount it inside
 * the host app's router and `QueryClientProvider`.
 *
 * @remarks
 * Four master/detail levels, each replacing the last with a control back.
 * Selection and filter state live here; filters reset per session, and an open
 * id that is no longer present falls back to the level above rather than
 * rendering an empty detail.
 *
 * The export hangs off this panel rather than off a tab of its own because its
 * first step — "a session, or a filtered subset of its exchanges" — is exactly
 * the state this panel already holds. A separate surface would need its own
 * session picker and its own copy of the filter bar.
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
  const [isExporting, setIsExporting] = useState(false)
  const [filters, setFilters] = useState<ExchangeFilters>(NO_FILTERS)

  const openSession = sessions.find((session) => session.sessionId === openSessionId)
  const openExchange = openSession?.exchanges.find(
    (exchange) => traceResourceId(exchange) === openExchangeId
  )

  /**
   * The exchanges an export would cover: the same pure `filterExchanges` over
   * the same `ExchangeFilters` the list is showing — the filter is reused, not
   * rebuilt. Memoised because the export hook rebuilds its preview whenever
   * this identity changes, and `filterExchanges` returns a fresh array.
   */
  const exportableExchanges = useMemo(
    (): readonly TraceExchange[] =>
      openSession === undefined ? [] : filterExchanges(openSession.exchanges, filters),
    [openSession, filters]
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
            setIsExporting(false)
            setFilters(NO_FILTERS)
          }}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          onLoadMore={loadMore}
          unreadableCount={unreadableCount}
        />
      )
    }
    if (isExporting) {
      return (
        <>
          {sessionHeader(openSession.sessionId, 'Back to exchanges', (): void => {
            setIsExporting(false)
          })}
          <ExportPanel
            exchanges={exportableExchanges}
            sessionExchangeCount={openSession.exchanges.length}
            sessionId={openSession.sessionId}
          />
        </>
      )
    }
    if (openExchange !== undefined) {
      return (
        <>
          {sessionHeader(openExchange.url, 'Back to exchanges', (): void => {
            setOpenExchangeId(null)
          })}
          <ExchangeDetail exchange={openExchange} />
        </>
      )
    }
    return (
      <>
        {sessionHeader(openSession.sessionId, 'All recordings', (): void => {
          setOpenSessionId(null)
        })}
        <div className={styles['recordings__session-actions']}>
          <button
            type="button"
            className="button-3 outline"
            onClick={(): void => {
              setOpenExchangeId(null)
              setIsExporting(true)
            }}
          >
            {`Export ${exportableExchanges.length === openSession.exchanges.length ? 'recording' : 'these exchanges'}…`}
          </button>
        </div>
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
