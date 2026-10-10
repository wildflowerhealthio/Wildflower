import { ExerciseConcept, ExerciseRequest } from '@wildflowerhealthio/lifting-core-js'

/**
 * The lifter's current load at each exercise, by exercise id, read off their
 * active `ExerciseRequest`s: what a restart suggests as each starting load.
 */
const currentLoadsOf = (
  activeExerciseRequests: readonly ExerciseRequest.Type[]
): ExerciseRequest.StartingLoads =>
  Object.fromEntries(
    activeExerciseRequests.map((exerciseRequest) => [
      ExerciseConcept.idOf(ExerciseRequest.exerciseOf(exerciseRequest)),
      ExerciseRequest.loadOf(exerciseRequest),
    ])
  )

export { currentLoadsOf }
