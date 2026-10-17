import { createFileRoute } from '@tanstack/react-router'
import type { JSX } from 'react'

import { WorkoutsList } from '../../../-workouts-list.tsx'

/** The Workouts tab: the lifter's completed workouts. */
function WorkoutsTab(): JSX.Element {
  const { patientId } = Route.useParams()
  return <WorkoutsList patientChoice={{ kind: 'patient', patientId }} />
}

/** `/patients/$patientId/workouts`, the lifter's Workouts tab. */
const Route = createFileRoute('/patients/$patientId/workouts')({
  component: WorkoutsTab,
})

export { Route }
