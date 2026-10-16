import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ItemList, type ItemListItem } from '@wildflowerhealthio/react-tundraish'
import {
  type HealthReport,
  type ListedServer,
  ServerStatus,
} from '@wildflowerhealthio/servers-core-js'
import { type DateTime, Match, Option } from 'effect'
import type { JSX, ReactNode } from 'react'

import { type ServerHealthError, serverHealthQueryOptions } from '../../../../queries.ts'
import { useRunHttpRequest } from '../../../../router-context.ts'
import {
  formatInstant,
  lastStopText,
  PLATFORM_STOP_REASON_TEXT,
} from '../../../../server-status-text.ts'
import { healthCheckTitle } from './-health-check-title.ts'
import { useListedServer } from './-listed-server.ts'

/**
 * What the Connection row says: the host's own check of the server's
 * `/health` through its public origin while a run is in progress, or how
 * its latest run stopped.
 *
 * @remarks
 * The host checks the health only while the tunnel is connected to the
 * relay, so a run whose tunnel hasn't connected has no health yet, and says
 * why. It stops checking once the health first answers, so once the tunnel's
 * connection has dropped or been refused, a `reachable` health is from
 * before then, and says so.
 */
const connectionText = (status: ServerStatus.Type): string =>
  Match.value({
    runState: status.runState,
    lastStop: Option.getOrUndefined(ServerStatus.lastStopOf(status)),
    health: Option.getOrUndefined(ServerStatus.healthOf(status)),
    tunnel: Option.getOrUndefined(ServerStatus.tunnelOf(status)),
  }).pipe(
    Match.withReturnType<string>(),
    Match.when({ runState: 'stopped', lastStop: Match.defined }, ({ lastStop }) =>
      lastStopText(lastStop)
    ),
    Match.when({ runState: 'stopped' }, () => "It hasn't run yet."),
    Match.when(
      { health: { kind: 'unreachable' } },
      ({ health }) => `Not reachable yet: ${health.error}`
    ),
    Match.when(
      {
        health: { kind: 'reachable' },
        tunnel: { kind: Match.is('reconnecting', 'tokenRejected', 'tunnelUnknown') },
      },
      ({ health }) =>
        `Reachable before its relay connection changed: its /health answered ${health.status}.`
    ),
    Match.when(
      { health: { kind: 'reachable' } },
      ({ health }) => `Reachable: its /health answers ${health.status}.`
    ),
    Match.when({ runState: 'starting' }, () => 'Starting.'),
    Match.when(
      {
        tunnel: { kind: Match.is('connecting', 'reconnecting', 'tokenRejected', 'tunnelUnknown') },
      },
      () => 'Not checked until the relay connection is up.'
    ),
    Match.orElse(() => 'Checking it can be reached.')
  )

/**
 * The Relay connection row, while a run in progress has reported its
 * tunnel's state: where the tunnel's connection to the relay stands, a
 * failure once the relay has refused the tunnel named `tunnelName`.
 */
const relayConnectionItems = ({ status, tunnelName }: ListedServer.Type): readonly ItemListItem[] =>
  ServerStatus.tunnelOf(status).pipe(
    Option.map((tunnel): ItemListItem => {
      const item = { id: 'relay-connection', title: 'Relay connection' } as const
      return Match.value(tunnel).pipe(
        Match.withReturnType<ItemListItem>(),
        Match.when({ kind: 'connecting' }, () => ({ ...item, subtitle: 'Connecting.' })),
        Match.when({ kind: 'connected' }, () => ({ ...item, subtitle: 'Connected.' })),
        Match.when({ kind: 'reconnecting' }, ({ error }) => ({
          ...item,
          subtitle: `Reconnecting: ${error}`,
        })),
        Match.when({ kind: 'tokenRejected' }, () => ({
          ...item,
          subtitle: 'The relay rejected the tunnel token. Enter a new one on the Relay tab.',
          tone: 'danger',
        })),
        Match.when({ kind: 'tunnelUnknown' }, () => ({
          ...item,
          subtitle: `The relay has no tunnel named ${tunnelName}. It may have been deleted.`,
          tone: 'danger',
        })),
        Match.exhaustive
      )
    }),
    Option.toArray
  )

/** The rows for how a stopped server's latest run stopped: the platform's reason, and when. */
const lastStopItems = (status: ServerStatus.Type): readonly ItemListItem[] =>
  ServerStatus.lastStopOf(status).pipe(
    Option.map((stop): readonly ItemListItem[] => [
      ...stop.platformReason.pipe(
        Option.map((reason): ItemListItem => ({
          id: 'platform-reason',
          title: 'Platform reason',
          subtitle: PLATFORM_STOP_REASON_TEXT[reason],
        })),
        Option.toArray
      ),
      { id: 'stopped-at', title: 'Stopped', subtitle: formatInstant(stop.stoppedAt) },
    ]),
    Option.getOrElse((): readonly ItemListItem[] => [])
  )

/**
 * The Health report row: the overall status `/health` answered with, or
 * why it couldn't be read, with `actions` at its end.
 */
const healthReportItem = (
  report: UseQueryResult<HealthReport.Type, ServerHealthError>,
  actions: ReactNode
): ItemListItem => {
  const item = { id: 'report', title: 'Health report', actions } as const
  if (report.isPending) return { ...item, subtitle: 'Reading…' }
  if (report.isError) {
    return { ...item, subtitle: `Couldn't read it: ${report.error.message}`, tone: 'danger' }
  }
  return {
    ...item,
    subtitle: `Its /health answers ${report.data.status}.`,
    tone: report.data.status === 'fail' ? 'danger' : 'neutral',
  }
}

/** A row for each check in `report`, titled by its key, with its status and when it ran. */
const healthCheckItems = (report: HealthReport.Type): readonly ItemListItem[] =>
  Object.entries(report.checks).flatMap(([key, checks]) =>
    checks.map((check, index): ItemListItem => ({
      id: `check-${key}-${String(index)}`,
      title: healthCheckTitle(key),
      meta: check.status,
      subtitle: `Checked ${formatInstant(check.time)}`,
      tone: check.status === 'fail' ? 'danger' : 'neutral',
    }))
  )

/**
 * The server's `/health` report, read by the webview through the relay and
 * the tunnel, once for the run that started at `runningSince`: its overall
 * status and each check, or why it couldn't be read; Refresh reads it again.
 */
const HealthReportList = ({
  domain,
  runningSince,
}: {
  readonly domain: string
  readonly runningSince: DateTime.Utc
}): JSX.Element => {
  const report = useQuery(serverHealthQueryOptions(useRunHttpRequest(), domain, runningSince))
  const refresh = (
    <button
      type="button"
      className="button-2 outline"
      disabled={report.isFetching}
      onClick={() => {
        void report.refetch()
      }}
    >
      Refresh
    </button>
  )
  return (
    <ItemList
      title="Health checks"
      maxLines={3}
      items={[
        healthReportItem(report, refresh),
        ...(report.isSuccess ? healthCheckItems(report.data) : []),
      ]}
    />
  )
}

/**
 * The server page's Status tab, `/servers/$domain/status`: the server's
 * connection, as the host last checked it, with its tunnel's connection to
 * the relay while a run reports it, or how the latest run stopped; and,
 * while the server runs, its `/health` report as the webview reads it.
 */
const ServerStatusTab = (): JSX.Element => {
  const server = useListedServer()
  return (
    <>
      <ItemList
        title="Connection"
        maxLines={3}
        items={[
          { id: 'connection', title: 'Connection', subtitle: connectionText(server.status) },
          ...relayConnectionItems(server),
          ...lastStopItems(server.status),
        ]}
      />
      {server.status.runState === 'running' ? (
        <HealthReportList domain={server.domain} runningSince={server.status.runningSince} />
      ) : null}
    </>
  )
}

export const Route = createFileRoute('/_servers/servers/$domain/status')({
  component: ServerStatusTab,
})
