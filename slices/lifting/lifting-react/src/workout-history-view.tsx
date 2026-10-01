import { Array as Arr, DateTime, Option, pipe } from 'effect'
import {
  ExerciseConcept,
  ExerciseRequest,
  ExerciseSetObservation,
  WorkoutProcedure,
} from 'lifting-core'
import type { JSX } from 'react'
import { useId } from 'react'
import { cn } from 'react-kitchen-sink'
import { ItemList, type ItemListItem, StatusBadge } from 'react-tundraish'

import { formatLoad, formatSetReps } from './load-format.ts'
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
 * One row of a workout: the exercise it carried out (by its `ServiceRequest`
 * id), its load and sets × reps, the reps of each set logged against it in
 * the workout, and whether they met it.
 */
const exerciseRowOf = ({
  workoutProcedure,
  serviceRequestId,
  exerciseSetObservations,
  exerciseRequests,
}: {
  readonly workoutProcedure: WorkoutProcedure.Type
  readonly serviceRequestId: string
  readonly exerciseSetObservations: readonly ExerciseSetObservation.Type[]
  readonly exerciseRequests: readonly ExerciseRequest.Type[]
}): Option.Option<ItemListItem> => {
  const setsInWorkout = ExerciseSetObservation.sortByStart(
    exerciseSetObservations.filter(
      (exerciseSetObservation) =>
        ExerciseSetObservation.serviceRequestIdOf(exerciseSetObservation) === serviceRequestId &&
        ExerciseSetObservation.procedureIdOf(exerciseSetObservation) === workoutProcedure.id
    )
  )
  const setReps = setsInWorkout.map(ExerciseSetObservation.repsOf)
  const exerciseRequest = Arr.findFirst(
    exerciseRequests,
    (candidate) => candidate.id === serviceRequestId
  )
  const exerciseConcept = pipe(
    Option.map(exerciseRequest, ExerciseRequest.exerciseOf),
    Option.orElse(() => Option.map(Arr.head(setsInWorkout), ExerciseSetObservation.exerciseOf))
  )
  return Option.map(exerciseConcept, (exercise) => ({
    id: serviceRequestId,
    title: ExerciseConcept.nameOf(exercise),
    subtitle: [
      ...Option.match(exerciseRequest, {
        onNone: () => [],
        onSome: (asked) => [
          formatLoad(ExerciseRequest.loadOf(asked)),
          `${ExerciseRequest.setsOf(asked)}×${ExerciseRequest.repsOf(asked)}`,
        ],
      }),
      setReps.length === 0 ? 'No sets logged' : formatSetReps(setReps),
    ].join(' · '),
    badge: Option.match(exerciseRequest, {
      onNone: () => undefined,
      onSome: (asked) =>
        Option.match(
          Arr.head(
            ExerciseRequest.attemptsAt(asked, {
              workoutProcedures: [workoutProcedure],
              exerciseSetObservations: setsInWorkout,
            })
          ),
          {
            onNone: () => <StatusBadge tone="neutral">Skipped</StatusBadge>,
            onSome: (attempt) =>
              ExerciseRequest.isMetBy(asked, attempt) ? (
                <StatusBadge tone="success">Met</StatusBadge>
              ) : (
                <StatusBadge tone="danger">Failed</StatusBadge>
              ),
          }
        ),
    }),
  }))
}

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
                exerciseRowOf({
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
