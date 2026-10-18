import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * `/patients/$patientId` itself, which opens the lifter's Today, replacing
 * the bare path in history, so Back leaves the page rather than landing on
 * it again.
 */
const Route = createFileRoute('/patients/$patientId/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/patients/$patientId/today', params, replace: true })
  },
})

export { Route }
