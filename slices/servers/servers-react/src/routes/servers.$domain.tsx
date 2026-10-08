import { createFileRoute } from '@tanstack/react-router'
import type { JSX } from 'react'

import { ServerPage } from '../server-page.tsx'

/** The server page for the route's `domain`. */
function ServerRoute(): JSX.Element {
  const { domain } = Route.useParams()
  return <ServerPage domain={domain} />
}

/** `/servers/$domain`, one server's page: its details and its removal. */
export const Route = createFileRoute('/servers/$domain')({ component: ServerRoute })
