import { DateTime, Duration } from 'effect'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { StatusBadge } from 'react-tundraish'
import type { TraceExchange } from 'web-trace-core'

import { AttachmentViewer } from '../attachments/attachment-viewer.tsx'
import { fromTraceBody } from '../attachments/viewable-attachment.ts'
import styles from './exchange-detail.module.css'

/** Props for {@link ExchangeDetail}. */
interface ExchangeDetailProps {
  /** The exchange to show, exactly as captured. */
  readonly exchange: TraceExchange
  readonly className?: string
}

/**
 * The badge tone for a response class. `0` is not a status the server sent, so
 * it is toned as a warning rather than as a success.
 */
const toneOf = (status: number): 'success' | 'info' | 'danger' | 'warning' => {
  if (status >= 200 && status < 300) return 'success'
  if (status >= 300 && status < 400) return 'info'
  if (status >= 400) return 'danger'
  return 'warning'
}

/** The status as it should read; `0` has no HTTP meaning to print. */
const describeStatus = (exchange: TraceExchange): string =>
  exchange.status === 0
    ? 'opaque'
    : `${exchange.status}${exchange.statusText === '' ? '' : ` ${exchange.statusText}`}`

/** A measured duration in milliseconds, or the fact that it was never measured. */
const describeTiming = (timing: Duration.Duration | null): string =>
  timing === null ? 'not measured' : `${Duration.toMillis(timing).toLocaleString()} ms`

/**
 * One recorded exchange in full: the captured request URL, the response status
 * and timings, every response header, and the body.
 *
 * @remarks
 * Everything renders **raw and unredacted**. This is the user's own device
 * showing the user's own data, so identifiers, tokens, and `Set-Cookie` values
 * appear as they were captured — a collector author needs to see what the
 * endpoint actually returns. Redaction is the export flow's job.
 *
 * The request side is stated as missing rather than guessed: the sniffer
 * observes no method, no request headers, and no request body, so the detail
 * says so instead of showing a plausible `GET`.
 */
const ExchangeDetail = ({ exchange, className }: ExchangeDetailProps): JSX.Element => (
  <article className={cn(styles['detail'], className)}>
    <div>
      <div className={styles['detail__summary']}>
        <StatusBadge tone={toneOf(exchange.status)}>{describeStatus(exchange)}</StatusBadge>
        <span className="text-body-3">
          {new Date(DateTime.toEpochMillis(exchange.startedAt)).toLocaleString()}
        </span>
      </div>
      <p className={cn(styles['detail__url'], 'text-body-2')}>{exchange.url}</p>
    </div>

    <p className={cn(styles['detail__note'], 'text-body-3')}>
      {`Wait ${describeTiming(exchange.timings.wait)} · receive ${describeTiming(exchange.timings.receive)}`}
    </p>

    <section aria-label="Response headers">
      <h3 className={cn(styles['detail__section-title'], 'text-label-3')}>Response headers</h3>
      {exchange.headers.length === 0 ? (
        <p className={cn(styles['detail__note'], 'text-body-3')}>No response headers recorded.</p>
      ) : (
        <dl className={styles['detail__headers']}>
          {exchange.headers.map(([name, value], index) => (
            // Header names repeat legitimately (`Set-Cookie`), and the capture
            // preserves order, so the index is part of the identity here.
            // oxlint-disable-next-line react/no-array-index-key -- duplicate header names are valid; position is the key
            <div key={`${name}-${index}`} style={{ display: 'contents' }}>
              <dt className={cn(styles['detail__header-name'], 'text-body-3')}>{name}</dt>
              <dd className={cn(styles['detail__header-value'], 'text-body-3')}>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>

    <section aria-label="Response body">
      <h3 className={cn(styles['detail__section-title'], 'text-label-3')}>Response body</h3>
      <AttachmentViewer
        attachment={fromTraceBody(exchange.body, exchange.url)}
        label="Response body content"
      />
    </section>

    <p className={cn(styles['detail__note'], 'text-body-3')}>
      The sniffer records no request method, request headers, or request body, so this trace cannot
      tell a GET from a POST to the same URL.
    </p>
  </article>
)

export { ExchangeDetail, type ExchangeDetailProps }
