import {
  ExerciseConcept,
  ExerciseRequest,
  ExerciseSetObservation,
  type WorkoutProcedure,
} from '@wildflowerhealthio/lifting-core-js'
import { type ItemListItem, StatusBadge } from '@wildflowerhealthio/react-tundraish'
import { Array as Arr, Option, pipe } from 'effect'

import { formatLoad, formatSetReps } from '../load-format.ts'

/**
 * One exercise of a workout in the history, as its `ItemList` item: the
 * exercise the workout carried out (by its `ServiceRequest` id), its load
 * and sets × reps, the reps of each set logged against it in the workout,
 * and whether they met it.
 */
const workoutExerciseItemOf = ({
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

export { workoutExerciseItemOf }
