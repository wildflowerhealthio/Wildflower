import { createFileRoute } from '@tanstack/react-router'
import type { JSX } from 'react'

import { PatientStatus } from '../-patient-status.tsx'
import { WorkoutsList } from '../-workouts-list.tsx'

/**
 * Every patient's completed workouts, under the patient line naming All
 * patients. There is no tab strip: Today and Plan write, and every write is
 * one lifter's.
 */
function EveryPatientsWorkouts(): JSX.Element {
  return (
    <>
      <PatientStatus patientChoice={{ kind: 'all-patients' }} />
      <WorkoutsList patientChoice={{ kind: 'all-patients' }} />
    </>
  )
}

/** `/workouts`, every patient's workouts, which the picker's All patients opens. */
const Route = createFileRoute('/workouts')({
  component: EveryPatientsWorkouts,
})

export { Route }
