import type { DateTime } from 'effect'
import type { PlannedWorkout } from 'lifting-core'

/**
 * A planned workout as the lifter performed it: what `PlannedWorkout.submit`
 * needs beside the planned workout itself, the lifter and the ids the app
 * mints.
 */
interface WorkoutSubmission {
  /** The reps of each set entered, by exercise id, in set order; an exercise with none entered is absent. */
  readonly setRepsByExerciseId: PlannedWorkout.SetRepsByExerciseId
  /** When the first set was entered. */
  readonly start: DateTime.Utc
  /** When the workout was submitted. */
  readonly end: DateTime.Utc
}

export type { WorkoutSubmission }
