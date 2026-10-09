import { useQuery } from '@tanstack/react-query'
import { Effect } from 'effect'
import { WorkoutHistoryView } from 'lifting-react'
import type { JSX } from 'react'
import { LoadingLine, type PatientChoice, patientScopeOf, ReadFailureLine } from 'smart-app-react'

import { UnreadableNotice } from '../record/unreadable-notice.tsx'
import { readWorkoutHistory } from '../record/workout-history.ts'
import { liftingKeyOf } from '../session/lifting-session.ts'
import type { SmartClient } from '../smart-client.ts'

/** Props for {@link HistoryTab}. */
interface HistoryTabProps {
  /** The SMART client every search is issued through. */
  readonly client: SmartClient
  /** Whose workouts: one lifter's, or every patient's. */
  readonly patientChoice: PatientChoice
}

/**
 * The completed workouts, newest first: `readWorkoutHistory` — read only once
 * the tab is opened, for the lifter or, with "All patients", unscoped —
 * shown by `WorkoutHistoryView`, with what could not be read said above it.
 * It only reads, so it needs no lifter.
 */
const HistoryTab = ({ client, patientChoice }: HistoryTabProps): JSX.Element => {
  const patientScope = patientScopeOf(patientChoice)
  const subject =
    patientChoice.kind === 'patient' ? 'your workout history' : "every patient's workout history"
  const workoutHistory = useQuery({
    queryKey: [...liftingKeyOf(patientScope), 'history'],
    queryFn: () => Effect.runPromise(readWorkoutHistory(client, patientScope)),
  })
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

export { HistoryTab, type HistoryTabProps }
