import {
  type ExerciseRequest,
  type ExerciseSetObservation,
  WorkoutProcedure,
} from '@wildflowerhealthio/lifting-core-js'
import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { ItemList } from '@wildflowerhealthio/react-tundraish'
import { Array as Arr, DateTime } from 'effect'
import type { JSX } from 'react'
import { useId } from 'react'

import { workoutExerciseItemOf } from './workout-exercise-item.tsx'
import styles from './workout-history-view.module.css'

interface WorkoutHistoryViewProps {
  /** The lifter's workouts, in any order; those still in progress are passed over. */
  readonly workoutProcedures: readonly WorkoutProcedure.Type[]
  /** The sets logged in them, in any order. */
  readonly exerciseSetObservations: readonly ExerciseSetObservation.Type[]
  /**
   * The `ExerciseRequest`s the workouts carried out — closed ones too, since
   * each workout was judged against the one it carried out.
   */
  readonly exerciseRequests: readonly ExerciseRequest.Type[]
}

/**
 * A formatter for when a workout started, e.g. `"Mon, Sep 21, 2026"`, in the
 * viewer's zone. Made per render: an `Intl.DateTimeFormat` fixes the zone it
 * was made in.
 */
const workoutDateFormat = (): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

/**
 * The **workout history**: every completed workout, newest first, each under
 * its day's label and the date it started, listing the exercises it carried
 * out with their load, sets × reps, the reps of each set logged, and whether
 * they met it.
 *
 * @remarks
 * Grouped by workout, not by calendar day: two workouts on one day are two
 * groups. Order is `WorkoutProcedure.completedByStart`, reversed; met or
 * failed is `ExerciseRequest.isMetBy` over the workout's attempt
 * (`ExerciseRequest.attemptsAt`). An exercise the workout carried out with no
 * set logged is no attempt, and reads "Skipped". A set's exercise is named
 * even when its `ExerciseRequest` is not among `exerciseRequests` — history
 * is never hidden for a missing `ServiceRequest` — but then has no badge.
 */
const WorkoutHistoryView = ({
  workoutProcedures,
  exerciseSetObservations,
  exerciseRequests,
}: WorkoutHistoryViewProps): JSX.Element => {
  const headingId = useId()
  const workoutDate = workoutDateFormat()
  const completedNewestFirst = Arr.reverse(WorkoutProcedure.completedByStart(workoutProcedures))
  return (
    <section className={styles['workout-history-view']} aria-labelledby={headingId}>
      <h2 id={headingId} className={cn('text-heading-6', styles['workout-history-view__heading'])}>
        History
      </h2>
      {completedNewestFirst.length === 0 ? (
        <p className={cn('text-body-2', styles['workout-history-view__empty'])}>
          No workouts yet. Submit one and it will show up here.
        </p>
      ) : (
        completedNewestFirst.map((workoutProcedure) => (
          <ItemList
            key={workoutProcedure.id}
            title={`Workout ${WorkoutProcedure.dayLabelOf(workoutProcedure)} · ${workoutDate.format(
              DateTime.toDateUtc(WorkoutProcedure.startOf(workoutProcedure))
            )}`}
            items={Arr.filterMap(
              WorkoutProcedure.serviceRequestIdsOf(workoutProcedure),
              (serviceRequestId) =>
                workoutExerciseItemOf({
                  workoutProcedure,
                  serviceRequestId,
                  exerciseSetObservations,
                  exerciseRequests,
                })
            )}
          />
        ))
      )}
    </section>
  )
}

export { WorkoutHistoryView }
export type { WorkoutHistoryViewProps }
