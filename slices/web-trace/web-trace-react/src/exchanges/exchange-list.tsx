import { DateTime } from 'effect'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { ItemList, StatusBadge, type ItemListItem, type StatusTone } from 'react-tundraish'
import { type TraceExchange } from 'web-trace-core'

import { ExchangeFiltersBar } from './exchange-filters.tsx'
import { exchangeKey } from './exchange-key.ts'
import { contentTypeOptions, filterExchanges, type ExchangeFilters } from './filter-exchanges.ts'
import styles from './exchange-list.module.css'

/** Props for {@link ExchangeList}. */
interface ExchangeListProps {
  /** The session's exchanges, unfiltered. Filtering happens here. */
  readonly exchanges: readonly TraceExchange[]
  /** The active filters. Fully controlled. */
  readonly filters: ExchangeFilters
  /** Called with the next whole filter set whenever a control changes. */
  readonly onFiltersChange: (next: ExchangeFilters) => void
  /** Called with an exchange when its row is activated. */
  readonly onSelectExchange: (exchange: TraceExchange) => void
  readonly className?: string
}

/**
 * The badge tone for a response class.
 *
 * @remarks
 * `0` is not a status the server sent — the sniffer reports it for an opaque or
 * aborted response — so it is toned as a warning rather than as a success.
 */
const toneOf = (status: number): StatusTone => {
  if (status >= 200 && status < 300) return 'success'
  if (status >= 300 && status < 400) return 'info'
  if (status >= 400) return 'danger'
  return 'warning'
}

/** The status as it should read in a badge; `0` has no HTTP meaning to print. */
const describeStatus = (exchange: TraceExchange): string =>
  exchange.status === 0
    ? 'opaque'
    : `${exchange.status}${exchange.statusText === '' ? '' : ` ${exchange.statusText}`}`

/**
 * How a row describes its body: the content type, and for a body the capture
 * policy declined to store, its size and why.
 *
 * @remarks
 * A skipped body reads as skipped, never as an empty one. The capture is
 * explicit about what it dropped, and flattening that into "no body" would make
 * the viewer claim something the trace does not.
 */
const describeBody = (exchange: TraceExchange): string => {
  const contentType = exchange.body.contentType === '' ? 'unknown type' : exchange.body.contentType
  return exchange.body._tag === 'SkippedBody'
    ? `${contentType} · body not stored (${exchange.body.size} bytes, ${exchange.body.reason})`
    : `${contentType} · ${exchange.body.size} bytes`
}

/**
 * A session's exchange list, filtered by URL, response class, and content type.
 *
 * @remarks
 * Rows show captured values as recorded — this is the user's own device and
 * their own data, and the viewer does not redact. Redaction belongs to the
 * export flow.
 */
const ExchangeList = ({
  exchanges,
  filters,
  onFiltersChange,
  onSelectExchange,
  className,
}: ExchangeListProps): JSX.Element => {
  const matching = filterExchanges(exchanges, filters)
  // `exchangeKey`, not `traceResourceId`: this runs for every matching row on
  // every render, including every keystroke in the filter bar above.
  const items: readonly ItemListItem[] = matching.map((exchange) => ({
    id: exchangeKey(exchange),
    title: <span className={styles['exchanges__url']}>{exchange.url}</span>,
    subtitle: describeBody(exchange),
    badge: <StatusBadge tone={toneOf(exchange.status)}>{describeStatus(exchange)}</StatusBadge>,
    meta: new Date(DateTime.toEpochMillis(exchange.startedAt)).toLocaleTimeString(),
    onClick: (): void => {
      onSelectExchange(exchange)
    },
  }))

  return (
    <div className={cn(styles['exchanges'], className)}>
      <ExchangeFiltersBar
        filters={filters}
        onFiltersChange={onFiltersChange}
        contentTypes={contentTypeOptions(exchanges)}
      />
      {items.length === 0 ? (
        <p className={cn(styles['exchanges__empty'], 'text-body-2')}>
          {exchanges.length === 0
            ? 'This recording has no exchanges.'
            : 'No exchanges match these filters.'}
        </p>
      ) : (
        <ItemList items={items} />
      )}
    </div>
  )
}

export { ExchangeList, type ExchangeListProps }
