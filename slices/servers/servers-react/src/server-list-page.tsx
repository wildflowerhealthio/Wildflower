import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { Link, useRouteContext } from '@tanstack/react-router'
import type { JSX } from 'react'
import { GateCard, PageBodyError, PageHeader } from 'react-tundraish'
import type { HostCommandError, ListedServer } from 'servers-core'

import { serversQueryOptions, useServerStatusEvents } from './queries.ts'
import type { RouterContext, RunHostCommand } from './router-context.ts'
import { ServerRow } from './server-row.tsx'
import styles from './server-list-page.module.css'

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
  if (servers.data.length === 0) {
    return (
      <GateCard
        showSpinner={false}
        title="No servers yet"
        body="The Wildflower servers on this device will be listed here."
      />
    )
  }
  return (
    <ul className={styles['server-list-page__servers']}>
      {servers.data.map((server) => (
        <ServerRow key={server.domain} server={server} runHostCommand={runHostCommand} />
      ))}
    </ul>
  )
}

/**
 * The base's home, `/`: the servers on this device, each with its run state,
 * health and run policy, kept current by the host's `server-status` events;
 * and the way to the base's Host Settings.
 *
 * @remarks
 * When the host can't read `servers.json`, the page shows the host's error,
 * with a retry.
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
      <ServerListBody servers={servers} runHostCommand={runHostCommand} />
    </>
  )
}

export { ServerListPage }
