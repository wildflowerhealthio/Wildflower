import { createFileRoute, redirect } from '@tanstack/react-router'
import { ServerStatus } from '@wildflowerhealthio/servers-core-js'
import { Option } from 'effect'

import { ensureListedServer } from './-listed-server.ts'

/**
 * `/servers/$domain` itself, which opens one of the page's tabs: Access while
 * a request waits on the server, and Status otherwise, replacing the bare
 * path in history.
 *
 * @remarks
 * `beforeLoad` reads the server's status from the cached server list, which
 * the page's own `beforeLoad` has just read, so the redirect neither reads
 * the list again nor has a failure of its own to show. A request that
 * arrives while the page is open doesn't move it off the tab it is on: the
 * request's approval page opens itself.
 */
const Route = createFileRoute('/_servers/servers/$domain/')({
  beforeLoad: async ({ context, params }) => {
    const server = await ensureListedServer(
      context.queryClient,
      context.runHostCommand,
      params.domain
    )
    throw redirect({
      to: Option.isSome(ServerStatus.pendingConsentOf(server.status))
        ? '/servers/$domain/access'
        : '/servers/$domain/status',
      params,
      replace: true,
    })
  },
})

export { Route }
