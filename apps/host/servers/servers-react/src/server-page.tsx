import { useQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { GateCard, PageBodyError, PageHeader, RouteTabs } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

import { ListedServerContext } from './listed-server-context.ts'
import { serversQueryOptions, useServerStatusEvents } from './queries.ts'
import type { RouterContext } from './router-context.ts'
import { StatusHero } from './status-hero.tsx'

/**
 * A server's page, `/servers/$domain`, opened by its card's Edit: its
 * status hero, with when it runs, over its tabs, each a child route the
 * strip links to. Status holds its connection, its `/health` report while
 * it runs, and its removal; Access, the newest consent waiting on it;
 * Default Apps, its launcher and its Authorization app; Relay, its relay
 * and tunnel, with a new tunnel token; Certificate, its certificate's
 * state.
 *
 * @remarks
 * The server is read from the same cached list as the server list, kept
 * current by the `server-status` event while the page is open, so a domain
 * the list doesn't hold says so, with the way back. The open tab reads the
 * server from {@link ListedServerContext}.
 */
const ServerPage = ({ domain }: { readonly domain: string }): JSX.Element => {
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
  const header = <PageHeader title="Server" subtitle={domain} backHref="/" backLabel="Servers" />
  if (servers.isPending) {
    return (
      <>
        {header}
        <GateCard title="Reading the servers on this device…" />
      </>
    )
  }
  if (servers.isError) {
    return (
      <>
        {header}
        <PageBodyError
          title="The servers on this device couldn't be read"
          error={servers.error}
          retry={() => {
            void servers.refetch()
          }}
        />
      </>
    )
  }
  const server = servers.data.find((listed) => listed.domain === domain)
  if (server === undefined) {
    return (
      <>
        {header}
        <GateCard title="This device has no server at this address." />
      </>
    )
  }
  const params = { domain }
  return (
    <>
      <PageHeader title="Server" backHref="/" backLabel="Servers" />
      <StatusHero server={server} runHostCommand={runHostCommand} />
      <ListedServerContext value={server}>
        <RouteTabs
          tabs={[
            { to: '/servers/$domain/status', params, label: 'Status' },
            { to: '/servers/$domain/access', params, label: 'Access' },
            { to: '/servers/$domain/default-apps', params, label: 'Default Apps' },
            { to: '/servers/$domain/relay', params, label: 'Relay' },
            { to: '/servers/$domain/certificate', params, label: 'Certificate' },
          ]}
          aria-label="Server details"
        />
      </ListedServerContext>
    </>
  )
}

export { ServerPage }
