import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { LoadingLine, patientScopeOf, ReadFailureLine } from '@wildflowerhealthio/smart-app-react'
import { WorkoutHistoryView } from '@wildflowerhealthio/strength-react'
import { Effect } from 'effect'
import type { JSX } from 'react'

import { useReadPatient } from '../-chosen-patient.ts'
import { UnreadableNotice } from '../../record/unreadable-notice.tsx'
import { readWorkoutHistory, type WorkoutHistory } from '../../record/workout-history.ts'
import { useStrengthContext } from '../../router-context.ts'
import { strengthKeyOf } from '../../session/strength-session.ts'

/** What the History tab shows: whose history it names, and its read. */
interface WorkoutHistoryRead {
  /** The history as the read lines name it: the lifter's, or every patient's. */
  readonly subject: string
  /** The history, read only once the tab is opened. */
  readonly workoutHistory: UseQueryResult<WorkoutHistory>
}

/**
 * The chosen patient's completed workouts (`readWorkoutHistory`), or, with
 * "All patients", every patient's, read unscoped.
 */
const useWorkoutHistory = (): WorkoutHistoryRead => {
  const { client } = useStrengthContext()
  const patientChoice = useReadPatient()
  const patientScope = patientScopeOf(patientChoice)
  const workoutHistory = useQuery({
    queryKey: [...strengthKeyOf(patientScope), 'history'],
    queryFn: () => Effect.runPromise(readWorkoutHistory(client, patientScope)),
  })
  return {
    subject:
      patientChoice.kind === 'patient' ? 'your workout history' : "every patient's workout history",
    workoutHistory,
  }
}

/**
 * The History tab: the completed workouts, newest first, shown by
 * `WorkoutHistoryView`, with what could not be read said above it. It only
 * reads, so it needs no lifter.
 */
function HistoryTab(): JSX.Element {
  const { subject, workoutHistory } = useWorkoutHistory()
  if (workoutHistory.isError) {
    return <ReadFailureLine subject={subject} error={workoutHistory.error} />
  }
  if (workoutHistory.data === undefined) return <LoadingLine subject={subject} />
  return (
    <>
      <UnreadableNotice unreadable={workoutHistory.data.unreadable} />
      <WorkoutHistoryView
        workoutProcedures={workoutHistory.data.workoutProcedures}
        exerciseSetObservations={workoutHistory.data.exerciseSetObservations}
        exerciseRequests={workoutHistory.data.exerciseRequests}
      />
    </>
  )
}

/** `/history`, the History tab. */
const Route = createFileRoute('/history')({
  component: HistoryTab,
})

export { Route }
