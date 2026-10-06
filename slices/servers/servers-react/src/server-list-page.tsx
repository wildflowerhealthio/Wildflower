import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { Link, useRouteContext } from '@tanstack/react-router'
import type { JSX } from 'react'
import { GateCard, ItemList, PageBodyError, PageHeader } from 'react-tundraish'
import type { HostCommandError, ListedServer } from 'servers-core'

import { serversQueryOptions } from './queries.ts'
import type { RouterContext } from './router-context.ts'

/** The page's body for the `servers_list` answer, or its failure. */
const ServerListBody = ({
  servers,
}: {
  readonly servers: UseQueryResult<readonly ListedServer[], HostCommandError>
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
    <ItemList items={servers.data.map((server) => ({ id: server.domain, title: server.domain }))} />
  )
}

/**
 * The base's home, `/`: the servers on this device, with the way to the
 * base's Host Settings.
 *
 * @remarks
 * Lists each server by its domain, or says why the host couldn't read them.
 */
const ServerListPage = (): JSX.Element => {
  const runHostCommand = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.runHostCommand,
  })
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
      <ServerListBody servers={servers} />
    </>
  )
}

export { ServerListPage }
