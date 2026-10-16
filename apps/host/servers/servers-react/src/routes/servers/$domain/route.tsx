import { createFileRoute, useRouter } from '@tanstack/react-router'
import { GateCard, PageBodyError, PageHeader, RouteTabs } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

import { useServerStatusEvents } from '../../../queries.ts'
import { useListenToHostEvent, useRunHostCommand } from '../../../router-context.ts'
import { ensureListedServer, useListedServer } from './-listed-server.ts'
import { StatusHero } from './-status-hero.tsx'

/** The page's header while it can't show the server: its title and domain, with the way back. */
const PlaceholderHeader = (): JSX.Element => {
  const { domain } = Route.useParams()
  return <PageHeader title="Server" subtitle={domain} backHref="/servers" backLabel="Servers" />
}

/** The page while the server list is read. */
const ServerPagePending = (): JSX.Element => (
  <>
    <PlaceholderHeader />
    <GateCard title="Reading the servers on this device…" />
  </>
)

/** The page when the server list couldn't be read: the host's error, with Retry. */
const ServerPageError = ({ error }: { readonly error: unknown }): JSX.Element => {
  const router = useRouter()
  return (
    <>
      <PlaceholderHeader />
      <PageBodyError
        title="The servers on this device couldn't be read"
        error={error}
        retry={() => {
          void router.invalidate()
        }}
      />
    </>
  )
}

/** The page for a domain the server list doesn't hold. */
const ServerPageNotFound = (): JSX.Element => (
  <>
    <PlaceholderHeader />
    <GateCard title="This device has no server at this address." />
  </>
)

/**
 * A server's page, opened by its card's Edit: its status hero over its tabs,
 * each a child route the strip links to. Status holds its connection and its
 * `/health` report while it runs; Access, the newest consent waiting on it;
 * Default Apps, its launcher and its Authorization app; Relay, its relay and
 * tunnel, with a new tunnel token; Certificate, its certificate's state;
 * Destructive actions, its removal. The
 * `server-status` event keeps the cached server list, and so the page,
 * current while it is open.
 */
function ServerPage(): JSX.Element {
  useServerStatusEvents(useListenToHostEvent())
  const server = useListedServer()
  const runHostCommand = useRunHostCommand()
  const params = { domain: server.domain }
  return (
    <>
      <PageHeader title="Server" backHref="/servers" backLabel="Servers" />
      <StatusHero server={server} runHostCommand={runHostCommand} />
      <RouteTabs
        tabs={[
          { to: '/servers/$domain/status', params, label: 'Status' },
          { to: '/servers/$domain/access', params, label: 'Access' },
          { to: '/servers/$domain/default-apps', params, label: 'Default Apps' },
          { to: '/servers/$domain/relay', params, label: 'Relay' },
          { to: '/servers/$domain/certificate', params, label: 'Certificate' },
          { to: '/servers/$domain/destructive-actions', params, label: 'Destructive actions' },
        ]}
        aria-label="Server details"
      />
    </>
  )
}

/**
 * `/servers/$domain`, one server's page, which each of its tabs is a child
 * route of.
 *
 * @remarks
 * `beforeLoad` reads the server from the cached server list, reading the
 * list when nothing is cached, before any tab's own `beforeLoad` runs: a
 * read that fails shows here, with Retry, and a domain the list doesn't hold
 * says so, each under the page's header with the way back.
 */
const Route = createFileRoute('/servers/$domain')({
  beforeLoad: async ({ context, params }) => {
    await ensureListedServer(context.queryClient, context.runHostCommand, params.domain)
  },
  pendingComponent: ServerPagePending,
  errorComponent: ServerPageError,
  notFoundComponent: ServerPageNotFound,
  component: ServerPage,
})

export { Route }
