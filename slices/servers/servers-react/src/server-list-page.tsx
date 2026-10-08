import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { Link, useRouteContext } from '@tanstack/react-router'
import type { JSX } from 'react'
import { GateCard, PageBodyError, PageHeader } from 'react-tundraish'
import type { HostCommandError, ListedServer } from 'servers-core'

import { serversQueryOptions, useServerStatusEvents } from './queries.ts'
import type { RouterContext, RunHostCommand } from './router-context.ts'
import { ServerCard } from './server-card.tsx'
import { useOnline } from './use-online.ts'
import styles from './server-list-page.module.css'

/** Why the Add server button is disabled. */
const ADD_SERVER_UNAVAILABLE = "Adding a server isn't available yet."

/** The body of a list with no servers: what a server is, and Add server. */
const NoServers = (): JSX.Element => (
  <div className={styles['server-list-page__empty']}>
    <p className={`text-heading-4 ${styles['server-list-page__empty-title']}`}>No servers yet</p>
    <p className={`text-body-2 ${styles['server-list-page__empty-body']}`}>
      A server keeps your health records on this device, and the apps you open from the web reach
      them at its own address, through a relay.
    </p>
    <button type="button" className="button-2 filled" disabled title={ADD_SERVER_UNAVAILABLE}>
      Add server
    </button>
  </div>
)

/** The page's body for the `servers_list` answer, or its failure. */
const ServerListBody = ({
  servers,
  runHostCommand,
}: {
  readonly servers: UseQueryResult<readonly ListedServer.Type[], HostCommandError>
  readonly runHostCommand: RunHostCommand
}): JSX.Element => {
  if (servers.isPending) return <GateCard title="Reading the servers on this device…" />
  if (servers.isError) {
    return (
      <PageBodyError
        title="The servers on this device couldn't be read"
        error={servers.error}
        retry={() => {
          void servers.refetch()
        }}
      />
    )
  }
  if (servers.data.length === 0) return <NoServers />
  return (
    <ul className={styles['server-list-page__servers']}>
      {servers.data.map((server) => (
        <ServerCard key={server.domain} server={server} runHostCommand={runHostCommand} />
      ))}
    </ul>
  )
}

/**
 * The base's home, `/`: a card for each server on this device, kept current
 * by the host's `server-status` events, or what a server is when there are
 * none; and the way to the base's Host Settings.
 *
 * @remarks
 * When the host can't read `servers.json`, the page shows the host's error,
 * with a retry. While the webview is offline, a notice says that launching
 * needs a connection.
 */
const ServerListPage = (): JSX.Element => {
  const runHostCommand = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.runHostCommand,
  })
  const listenToHostEvent = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.listenToHostEvent,
  })
  useServerStatusEvents(listenToHostEvent)
  const servers = useQuery(serversQueryOptions(runHostCommand))
  const online = useOnline()
  return (
    <>
      <PageHeader
        title="Servers"
        actions={
          <Link to="/settings" className="button button-2 outline">
            Host Settings
          </Link>
        }
      />
      {online ? null : (
        <p className={`text-body-2 ${styles['server-list-page__offline']}`} role="status">
          You're offline. Apps open from the web, so launching needs a connection.
        </p>
      )}
      <ServerListBody servers={servers} runHostCommand={runHostCommand} />
    </>
  )
}

export { ServerListPage }
