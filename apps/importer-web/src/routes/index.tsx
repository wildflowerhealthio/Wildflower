import { createFileRoute } from '@tanstack/react-router'
import { appRootRedirect } from '@wildflowerhealthio/smart-app-react'

/**
 * `/` itself, which replaces itself in history with the route the launch
 * started on, else the Import tab, so Back leaves the page rather than
 * landing on it again.
 */
const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw appRootRedirect('/import')
  },
})

export { Route }
