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

/** The servers, a card each. */
const ServerCards = ({
  servers,
  runHostCommand,
}: {
  readonly servers: readonly ListedServer.Type[]
  readonly runHostCommand: RunHostCommand
}): JSX.Element => (
  <ul className={styles['server-list-page__servers']}>
    {servers.map((server) => (
      <ServerCard key={server.domain} server={server} runHostCommand={runHostCommand} />
    ))}
  </ul>
)

/** A gear, the Host Settings link's icon. */
const SettingsIcon = (): JSX.Element => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
  </svg>
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
  return <ServerCards servers={servers.data} runHostCommand={runHostCommand} />
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
          <Link
            to="/settings"
            className={`button button-2 ghost ${styles['server-list-page__settings']}`}
            aria-label="Host Settings"
            title="Host Settings"
          >
            <SettingsIcon />
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
