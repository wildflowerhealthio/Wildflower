import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { ErrorBanner, PageLoading } from '@wildflowerhealthio/react-tundraish'
import { DateTime } from 'effect'
import type { JSX } from 'react'

import { useConnectionTotalsQuery, type ConnectionTotals } from './queries/index.ts'
import styles from './connection-totals.module.css'

/** Every count of a row but `ok`: the reasons a connection was refused. */
type Refusal = Exclude<keyof ConnectionTotals, 'hour' | 'ok'>

/** The refusal reasons, in the relay's order, each with its column heading. */
const REFUSALS: readonly (readonly [Refusal, string])[] = [
  ['over_connection_limit', 'Relay at its limit'],
  ['hello_timeout', 'No hello in time'],
  ['not_a_hello', 'Not TLS'],
  ['no_server_name', 'No host name'],
  ['unknown_tunnel', 'Unknown tunnel'],
  ['tunnel_down', 'Device offline'],
  ['tunnel_busy', 'Device not taking connections'],
  ['tunnel_closed', 'Closed by the tunnel'],
  ['proxy_header_failed', 'Relay error'],
]

/** A row's counts: every outcome's. */
type Counts = Omit<ConnectionTotals, 'hour'>

/** One table row: a UTC hour or day and its counts. */
interface TotalsRow {
  readonly start: DateTime.Utc
  readonly counts: Counts
}

const refusedOf = (counts: Counts): number =>
  REFUSALS.reduce((sum, [refusal]) => sum + counts[refusal], 0)

const sumOf = (left: Counts, right: Counts): Counts => ({
  ok: left.ok + right.ok,
  over_connection_limit: left.over_connection_limit + right.over_connection_limit,
  hello_timeout: left.hello_timeout + right.hello_timeout,
  not_a_hello: left.not_a_hello + right.not_a_hello,
  no_server_name: left.no_server_name + right.no_server_name,
  unknown_tunnel: left.unknown_tunnel + right.unknown_tunnel,
  tunnel_down: left.tunnel_down + right.tunnel_down,
  tunnel_busy: left.tunnel_busy + right.tunnel_busy,
  tunnel_closed: left.tunnel_closed + right.tunnel_closed,
  proxy_header_failed: left.proxy_header_failed + right.proxy_header_failed,
})

const hourlyRow = ({ hour, ...counts }: ConnectionTotals): TotalsRow => ({ start: hour, counts })

/** The hours summed by UTC day, in the hours' order. */
const dailyRows = (hours: readonly ConnectionTotals[]): readonly TotalsRow[] => {
  const days = new Map<number, TotalsRow>()
  for (const { hour, ...counts } of hours) {
    const start = DateTime.startOf(hour, 'day')
    const day = DateTime.toEpochMillis(start)
    const before = days.get(day)
    days.set(day, { start, counts: before === undefined ? counts : sumOf(before.counts, counts) })
  }
  return [...days.values()]
}

/** `2026-10-16 13:00`, in UTC. */
const formatHour = (start: DateTime.Utc): string =>
  `${DateTime.formatIsoDateUtc(start)} ${String(DateTime.getPartUtc(start, 'hours')).padStart(2, '0')}:00`

interface TotalsTableProps {
  readonly caption: string
  readonly timeHeading: string
  /** Newest first. */
  readonly rows: readonly TotalsRow[]
  readonly formatStart: (start: DateTime.Utc) => string
}

/**
 * Time, reached the device, refused, then one column per refusal reason that
 * any row of this table has.
 */
const TotalsTable = ({
  caption,
  timeHeading,
  rows,
  formatStart,
}: TotalsTableProps): JSX.Element => {
  const reasons = REFUSALS.filter(([refusal]) => rows.some((row) => row.counts[refusal] > 0))
  return (
    <div className={styles['connection-totals__scroll']}>
      <table className={cn(styles['connection-totals__table'], 'text-body-3')}>
        <caption className="text-heading-6">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{timeHeading}</th>
            <th scope="col">Reached device</th>
            <th scope="col">Refused</th>
            {reasons.map(([refusal, heading]) => (
              <th key={refusal} scope="col">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={DateTime.toEpochMillis(row.start)}>
              <th scope="row">
                <time dateTime={DateTime.formatIso(row.start)}>{formatStart(row.start)}</time>
              </th>
              <td className={styles['connection-totals__count']}>{row.counts.ok}</td>
              <td className={styles['connection-totals__count']}>{refusedOf(row.counts)}</td>
              {reasons.map(([refusal]) => (
                <td key={refusal} className={styles['connection-totals__count']}>
                  {row.counts[refusal]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * How many connections to the relay's tunnels reached a device, and how many
 * were refused and why: per UTC hour for the last 24 hours, and per UTC day
 * for the last 30, newest first. The relay keeps no more than these counts,
 * with no tunnel names or addresses.
 */
const ConnectionTotalsTables = (): JSX.Element => {
  const totals = useConnectionTotalsQuery()
  if (totals.isPending) return <PageLoading message="Loading connection totals…" />
  if (totals.isError) return <ErrorBanner error={totals.error} />
  const dayAgo = DateTime.subtract(DateTime.unsafeNow(), { hours: 24 })
  const newestFirst = totals.data.toReversed()
  const lastDay = newestFirst
    .filter((hour) => DateTime.greaterThan(hour.hour, dayAgo))
    .map(hourlyRow)
  return (
    <section className={styles['connection-totals']}>
      <h2 className="text-heading-4">Connections</h2>
      {totals.data.length === 0 ? (
        <p className="text-body-2">No connections in the last 30 days.</p>
      ) : (
        <>
          {lastDay.length === 0 ? (
            <p className="text-body-2">No connections in the last 24 hours.</p>
          ) : (
            <TotalsTable
              caption="Last 24 hours"
              timeHeading="Hour (UTC)"
              rows={lastDay}
              formatStart={formatHour}
            />
          )}
          <TotalsTable
            caption="Last 30 days"
            timeHeading="Day (UTC)"
            rows={dailyRows(newestFirst)}
            formatStart={DateTime.formatIsoDateUtc}
          />
        </>
      )}
    </section>
  )
}

export { ConnectionTotalsTables }
