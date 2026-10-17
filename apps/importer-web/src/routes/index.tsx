import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * `/` itself, which opens the Import tab, replacing the bare path in history,
 * so Back leaves the page rather than landing on it again.
 */
const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/import', replace: true })
  },
})

export { Route }
