import { type QueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { notFound, useParams } from '@tanstack/react-router'
import type { ListedServer } from '@wildflowerhealthio/servers-core-js'

import { listedServerQueryOptions, serversQueryOptions } from '../../../../queries.ts'
import { type RunHostCommand, useRunHostCommand } from '../../../../router-context.ts'

/** The id of the server page's route, whose not-found boundary a missing server reaches. */
const SERVER_PAGE_ROUTE_ID = '/_servers/servers/$domain'

/** The server `domain` in `servers`, or a not-found for the server page's route. */
const listedServerIn = (
  servers: readonly ListedServer.Type[],
  domain: string
): ListedServer.Type => {
  const server = servers.find((listed) => listed.domain === domain)
  if (server === undefined) throw notFound({ routeId: SERVER_PAGE_ROUTE_ID })
  return server
}

/**
 * The server `domain` as the cached server list holds it, reading the list
 * when nothing is cached, and taking what is cached as it is; for a route's
 * `beforeLoad`.
 *
 * @throws The read's failure, or a not-found for the server page's route
 * when the list doesn't hold the server.
 */
const ensureListedServer = async (
  queryClient: QueryClient,
  runHostCommand: RunHostCommand,
  domain: string
): Promise<ListedServer.Type> =>
  listedServerIn(
    await queryClient.query({ ...serversQueryOptions(runHostCommand), staleTime: 'static' }),
    domain
  )

/**
 * The server whose page is open, the route's `$domain`, from the cached
 * server list, which `server-status` events keep current, so the caller
 * renders again as its status changes.
 *
 * @remarks
 * The server page's `beforeLoad` has read the list and found the server, so
 * this suspends on nothing. A server the list stops holding, as once it is
 * removed, throws a not-found for the server page's route.
 */
const useListedServer = (): ListedServer.Type => {
  const { domain } = useParams({ from: SERVER_PAGE_ROUTE_ID })
  const { data: server } = useSuspenseQuery(listedServerQueryOptions(useRunHostCommand(), domain))
  if (server === undefined) throw notFound({ routeId: SERVER_PAGE_ROUTE_ID })
  return server
}

export { ensureListedServer, useListedServer }
