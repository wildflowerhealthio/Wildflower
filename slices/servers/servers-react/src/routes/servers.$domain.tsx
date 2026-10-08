import { createFileRoute } from '@tanstack/react-router'
import type { JSX } from 'react'

import { ServerPage } from '../server-page.tsx'

/** The server page for the route's `domain`. */
function ServerRoute(): JSX.Element {
  const { domain } = Route.useParams()
  return <ServerPage domain={domain} />
}

/**
 * `/servers/$domain`, one server's page: its status and run policy, its relay
 * and tunnel, its launcher, its certificates and its removal.
 */
export const Route = createFileRoute('/servers/$domain')({ component: ServerRoute })
