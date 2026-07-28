import { DateTime, Duration } from 'effect'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import type { TraceExchange } from 'web-trace-core'

import { bodyText } from './body-text.ts'
import styles from './exchange-detail.module.css'

/** Props for {@link ExchangeDetail}. */
interface ExchangeDetailProps {
  readonly exchange: TraceExchange
  /** Called when the detail is dismissed, returning to the exchange list. */
  readonly onClose: () => void
}

/** A measured timing in milliseconds, or the fact that nothing measured it. */
const describeTiming = (timing: Duration.Duration | null): string =>
  timing === null ? 'not measured' : `${Duration.toMillis(timing)} ms`

/**
 * The exchange detail surface. `RecordingsPanel` deliberately does not render
 * one — the host app owns it — so it lives here.
 *
 * @remarks
 * Values are shown exactly as captured. This runs on the user's own device
 * against the user's own data, and redaction belongs to the export boundary; a
 * viewer that redacted would make the recording useless for the thing it exists
 * for, which is reading what the portal actually sent.
 *
 * There is no request method, no request headers, and no request body, because
 * the sniffer reports none of them. The surface says so rather than leaving a
 * reader to assume a GET.
 */
const ExchangeDetail = ({ exchange, onClose }: ExchangeDetailProps): JSX.Element => {
  const body = bodyText(exchange.body)
  return (
    <section className={styles['detail']}>
      <div className={styles['detail__header']}>
        <button type="button" className="button-3 outline" onClick={onClose}>
          Back to exchanges
        </button>
        <p className={cn(styles['detail__status'], 'text-label-3')}>
          {exchange.status === 0 ? 'opaque' : `${exchange.status} ${exchange.statusText}`}
        </p>
      </div>

      <h2 className={cn(styles['detail__url'], 'text-heading-4')}>{exchange.url}</h2>

      <dl className={styles['detail__facts']}>
        <dt>Started</dt>
        <dd>{DateTime.formatIso(exchange.startedAt)}</dd>
        <dt>Wait</dt>
        <dd>{describeTiming(exchange.timings.wait)}</dd>
        <dt>Receive</dt>
        <dd>{describeTiming(exchange.timings.receive)}</dd>
        <dt>Content type</dt>
        <dd>{exchange.body.contentType === '' ? 'unknown' : exchange.body.contentType}</dd>
      </dl>

      <p className={cn(styles['detail__note'], 'text-body-3')}>
        The capture observes the response only — this trace carries no request method, headers, or
        body.
      </p>

      <h3 className="text-label-2">Response headers</h3>
      {exchange.headers.length === 0 ? (
        <p className={cn(styles['detail__note'], 'text-body-3')}>No headers were recorded.</p>
      ) : (
        <dl className={styles['detail__headers']}>
          {exchange.headers.map(([name, value]) => (
            <div key={`${name}:${value}`} className={styles['detail__header-row']}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}

      <h3 className="text-label-2">Response body</h3>
      {body.kind === 'text' && <pre className={styles['detail__body']}>{body.text}</pre>}
      {body.kind === 'binary' && (
        <p className={cn(styles['detail__note'], 'text-body-3')}>
          {body.size} bytes of {body.contentType === '' ? 'unknown type' : body.contentType}, not
          UTF-8 text. Export the recording to inspect it.
        </p>
      )}
      {body.kind === 'skipped' && (
        <p className={cn(styles['detail__note'], 'text-body-3')}>
          Body not stored — {body.size} bytes, {body.reason}.
        </p>
      )}
    </section>
  )
}

export { ExchangeDetail, type ExchangeDetailProps }
