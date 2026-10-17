import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import {
  LoadingLine,
  type PatientChoice,
  patientScopeOf,
  ReadFailureLine,
} from '@wildflowerhealthio/smart-app-react'
import { WorkoutHistoryView } from '@wildflowerhealthio/strength-react'
import { Effect } from 'effect'
import type { JSX } from 'react'

import { UnreadableNotice } from '../record/unreadable-notice.tsx'
import { readWorkoutHistory, type WorkoutHistory } from '../record/workout-history.ts'
import { useStrengthContext } from '../router-context.ts'
import { strengthKeyOf } from '../session/strength-session.ts'

/** What the workouts list shows: whose workouts it names, and their read. */
interface WorkoutHistoryRead {
  /** The workouts as the read lines name them: the lifter's, or every patient's. */
  readonly subject: string
  /** The workouts, read only once the list is open. */
  readonly workoutHistory: UseQueryResult<WorkoutHistory>
}

/**
 * The completed workouts (`readWorkoutHistory`) of the patient chosen, or,
 * for every patient, all of them, read unscoped.
 */
const useWorkoutHistory = (patientChoice: PatientChoice): WorkoutHistoryRead => {
  const { client } = useStrengthContext()
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
 * The completed workouts of `patientChoice`, newest first, shown by
 * `WorkoutHistoryView`, with what could not be read said above them: a
 * lifter's Workouts tab, and every patient's `/workouts`. It only reads, so
 * it needs no lifter.
 */
function WorkoutsList({ patientChoice }: { readonly patientChoice: PatientChoice }): JSX.Element {
  const { subject, workoutHistory } = useWorkoutHistory(patientChoice)
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

export { WorkoutsList }
