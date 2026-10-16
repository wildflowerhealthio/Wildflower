import { createFileRoute, redirect } from '@tanstack/react-router'

/** `/`, which opens the server list, `/servers`, replacing itself in history. */
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/servers', replace: true })
  },
})
