import { ExerciseRequest, PlannedWorkout } from 'lifting-core-js'

import { exerciseSetObservationIdOf } from './exercise-set-observation-id.ts'
import { mintResourceId } from './mint-resource-id.ts'

/** The key one {@link PlannedWorkout.IdToMint} is remembered under. */
const idToMintKeyOf = (idToMint: PlannedWorkout.IdToMint): string => {
  if (idToMint.resourceType === 'Procedure') return 'Procedure'
  if (idToMint.resourceType === 'Observation') {
    return `Observation/${idToMint.exerciseId}/${idToMint.setIndex}`
  }
  return `ServiceRequest/${idToMint.exerciseId}`
}

/**
 * The `mintId` for one submission of `plannedWorkout`: the workout's
 * `Procedure` id minted once, each set's `Observation` id from it
 * ({@link exerciseSetObservationIdOf}), and each next `ServiceRequest` id
 * minted the first time it is asked for — each remembered, so the same
 * {@link PlannedWorkout.IdToMint} names the same id on every call, a retry's
 * included.
 */
const workoutIdMinter = (
  plannedWorkout: PlannedWorkout.Type
): ((idToMint: PlannedWorkout.IdToMint) => string) => {
  const procedureId = mintResourceId()
  const setsByExerciseId = new Map(
    plannedWorkout.plannedWorkoutExercises.map((plannedWorkoutExercise) => [
      PlannedWorkout.exerciseIdOf(plannedWorkoutExercise),
      ExerciseRequest.setsOf(plannedWorkoutExercise.exerciseRequest),
    ])
  )
  const mintFor = (idToMint: PlannedWorkout.IdToMint): string => {
    if (idToMint.resourceType === 'Procedure') return procedureId
    if (idToMint.resourceType === 'Observation') {
      return exerciseSetObservationIdOf({
        procedureId,
        exerciseId: idToMint.exerciseId,
        setIndex: idToMint.setIndex,
        sets: setsByExerciseId.get(idToMint.exerciseId) ?? idToMint.setIndex + 1,
      })
    }
    return mintResourceId()
  }
  const mintedIds = new Map<string, string>()
  return (idToMint) => {
    const key = idToMintKeyOf(idToMint)
    const known = mintedIds.get(key)
    if (known !== undefined) return known
    const minted = mintFor(idToMint)
    mintedIds.set(key, minted)
    return minted
  }
}

export { workoutIdMinter }
