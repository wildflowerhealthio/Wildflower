import { createFileRoute } from '@tanstack/react-router'
import type { JSX } from 'react'

import { ServerPage } from '../../server-page.tsx'

/** The server page for the route's `domain`. */
function ServerRoute(): JSX.Element {
  const { domain } = Route.useParams()
  return <ServerPage domain={domain} />
}

/**
 * `/servers/$domain`, one server's page: its status hero over its tabs,
 * each a child route — `status`, `access`, `default-apps`, `relay` and
 * `certificate` — whose panel the open one fills.
 */
export const Route = createFileRoute('/_servers/servers/$domain')({ component: ServerRoute })
