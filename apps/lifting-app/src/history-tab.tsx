import { useQuery } from '@tanstack/react-query'
import { Effect } from 'effect'
import { WorkoutHistoryView } from 'lifting-react'
import type { JSX } from 'react'
import { LoadingLine, ReadFailureLine } from 'smart-app-react'

import { readWorkoutHistory } from './lifting-record.ts'
import { liftingKeyOf, type LiftingSession } from './lifting-session.ts'
import { UnreadableNotice } from './record-notices.tsx'

/**
 * The completed workouts, newest first: `readWorkoutHistory` — read only once
 * the tab is opened — shown by `WorkoutHistoryView`, with what could not be
 * read said above it.
 */
const HistoryTab = ({ session }: { readonly session: LiftingSession }): JSX.Element => {
  const workoutHistory = useQuery({
    queryKey: [...liftingKeyOf(session.patientId), 'history'],
    queryFn: () => Effect.runPromise(readWorkoutHistory(session.client, session.patientId)),
  })
  if (workoutHistory.isError) {
    return <ReadFailureLine subject="your workout history" error={workoutHistory.error} />
  }
  if (workoutHistory.data === undefined) return <LoadingLine subject="your workout history" />
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

export { HistoryTab }
