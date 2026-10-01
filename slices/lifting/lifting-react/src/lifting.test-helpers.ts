import { Array as Arr, DateTime } from 'effect'
import {
  ExerciseRequest,
  type ExerciseSetObservation,
  PlannedWorkout,
  type TrainingPlanDefinition,
  type WorkoutProcedure,
} from 'lifting-core'
import { AUTHORED_ON, made, SUBJECT } from 'lifting-core/test-helpers'

/**
 * Everything a lifter has written under one training plan definition: every
 * `ExerciseRequest` (closed ones too), workout and set — what the app would
 * have read back from the server.
 */
interface LifterRecord {
  readonly trainingPlanDefinition: TrainingPlanDefinition.Type
  readonly exerciseRequests: readonly ExerciseRequest.Type[]
  readonly workoutProcedures: readonly WorkoutProcedure.Type[]
  readonly exerciseSetObservations: readonly ExerciseSetObservation.Type[]
}

/** When the `index`th workout starts: 17:30 UTC, a day apart from Monday 21 September 2026. */
const workoutStartAt = (index: number): DateTime.Utc =>
  DateTime.unsafeMake(Date.UTC(2026, 8, 21, 17, 30) + index * 86_400_000)

/** When the `index`th workout ends: an hour after it starts. */
const workoutEndAt = (index: number): DateTime.Utc =>
  DateTime.addDuration(workoutStartAt(index), '1 hour')

/** A lifter starting `trainingPlanDefinition` at `startingLoads`, each `ServiceRequest` stored as `sr-<exercise id>`. */
const startedLifterRecord = ({
  trainingPlanDefinition,
  startingLoads,
}: {
  readonly trainingPlanDefinition: TrainingPlanDefinition.Type
  readonly startingLoads: ExerciseRequest.StartingLoads
}): LifterRecord => ({
  trainingPlanDefinition,
  exerciseRequests: made(
    ExerciseRequest.makeForEachExercise({
      subject: SUBJECT,
      trainingPlanDefinition,
      startingLoads,
      mintServiceRequestId: (exerciseId) => `sr-${exerciseId}`,
      authoredOn: AUTHORED_ON,
    })
  ),
  workoutProcedures: [],
  exerciseSetObservations: [],
})

/** The workout due next for the lifter. */
const plannedWorkoutOf = (lifterRecord: LifterRecord): PlannedWorkout.Type =>
  made(PlannedWorkout.make(lifterRecord))

/**
 * The workout due next submitted with `setRepsByExerciseId`, as the
 * `workoutProcedures.length`th workout ({@link workoutStartAt} to
 * {@link workoutEndAt}), every id minted from that index.
 */
const submittedOf = ({
  lifterRecord,
  setRepsByExerciseId,
}: {
  readonly lifterRecord: LifterRecord
  readonly setRepsByExerciseId: PlannedWorkout.SetRepsByExerciseId
}): PlannedWorkout.Submitted => {
  const index = lifterRecord.workoutProcedures.length
  return made(
    PlannedWorkout.submit({
      plannedWorkout: plannedWorkoutOf(lifterRecord),
      subject: SUBJECT,
      start: workoutStartAt(index),
      end: workoutEndAt(index),
      setRepsByExerciseId,
      mintId: (idToMint) => {
        if (idToMint.resourceType === 'Procedure') return `workout-${index}`
        if (idToMint.resourceType === 'Observation')
          return `set-${index}-${idToMint.exerciseId}-${idToMint.setIndex}`
        return `sr-${index}-${idToMint.exerciseId}`
      },
    })
  )
}

/** The lifter's record once what `submitted` writes is written. */
const withSubmitted = ({
  lifterRecord,
  submitted,
}: {
  readonly lifterRecord: LifterRecord
  readonly submitted: PlannedWorkout.Submitted
}): LifterRecord => {
  const written = submitted.exerciseRequestProgresses.flatMap(({ current, next }) => [
    current,
    ...Arr.fromOption(next),
  ])
  const writtenIds = new Set(written.map(({ id }) => id))
  return {
    ...lifterRecord,
    exerciseRequests: [
      ...lifterRecord.exerciseRequests.filter(({ id }) => !writtenIds.has(id)),
      ...written,
    ],
    workoutProcedures: [...lifterRecord.workoutProcedures, submitted.workoutProcedure],
    exerciseSetObservations: [
      ...lifterRecord.exerciseSetObservations,
      ...submitted.exerciseSetObservations,
    ],
  }
}

/** The lifter's record once the workout due is submitted with `setRepsByExerciseId` and written. */
const afterWorkout = ({
  lifterRecord,
  setRepsByExerciseId,
}: {
  readonly lifterRecord: LifterRecord
  readonly setRepsByExerciseId: PlannedWorkout.SetRepsByExerciseId
}): LifterRecord =>
  withSubmitted({
    lifterRecord,
    submitted: submittedOf({ lifterRecord, setRepsByExerciseId }),
  })

export {
  afterWorkout,
  plannedWorkoutOf,
  startedLifterRecord,
  submittedOf,
  withSubmitted,
  workoutEndAt,
  workoutStartAt,
}
export type { LifterRecord }
