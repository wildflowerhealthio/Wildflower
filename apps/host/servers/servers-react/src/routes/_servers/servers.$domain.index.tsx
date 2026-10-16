import { createFileRoute, Navigate } from '@tanstack/react-router'
import { ServerStatus } from '@wildflowerhealthio/servers-core-js'
import { Option } from 'effect'
import type { JSX } from 'react'

import { useListedServer } from '../../listed-server-context.ts'

/**
 * Opens the server page on its Access tab while a request waits on the
 * server, and on Status otherwise, replacing the bare path in history.
 */
function ServerIndexRoute(): JSX.Element {
  const server = useListedServer()
  const params = Route.useParams()
  const openingTab = Option.isSome(ServerStatus.pendingConsentOf(server.status))
    ? '/servers/$domain/access'
    : '/servers/$domain/status'
  return <Navigate to={openingTab} params={params} replace />
}

/**
 * `/servers/$domain` itself, which opens one of the page's tabs.
 *
 * @remarks
 * It redirects as it renders, under the page's tabs, rather than in
 * `beforeLoad`: the tab it opens hangs on the server's status, which the
 * page reads from the cached server list and shows the failure of itself, so
 * the redirect waits on that same read. A request that arrives while the
 * page is open doesn't move it off the tab it is on: the request's approval
 * page opens itself.
 */
export const Route = createFileRoute('/_servers/servers/$domain/')({ component: ServerIndexRoute })
