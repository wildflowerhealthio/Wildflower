import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * `/` itself, which opens a tab, replacing the bare path in history, so Back
 * leaves the page rather than landing on it again: Today for a lifter, and
 * History for All patients, whose Today only asks for a patient.
 */
const Route = createFileRoute('/')({
  beforeLoad: ({ context }) => {
    throw redirect({
      to: context.patientChoice.kind === 'patient' ? '/today' : '/history',
      replace: true,
    })
  },
})

export { Route }
