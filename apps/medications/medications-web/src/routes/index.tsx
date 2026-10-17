import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * `/` itself, which opens the Medications tab, replacing the bare path in
 * history, so Back leaves the page rather than landing on it again.
 */
const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/medications', replace: true })
  },
})

export { Route }
