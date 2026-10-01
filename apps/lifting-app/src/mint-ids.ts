import { fnv1a64 } from 'kitchen-sink'
import { ExerciseRequest, PlannedWorkout } from 'lifting-core'

/**
 * The ids the app mints for what it writes. Every resource is written by a
 * `PUT` to an id minted here, never by a server-assigned `POST`, so a retry
 * that mints the same ids overwrites what already landed instead of
 * duplicating it.
 *
 * @packageDocumentation
 */

/** The longest id FHIR R4 allows: an `id` is `[A-Za-z0-9\-\.]{1,64}`. */
const FHIR_ID_MAX_LENGTH = 64

/** A new id for a resource: a random UUID, 36 characters FHIR allows in an `id`. */
const mintResourceId = (): string => globalThis.crypto.randomUUID()

/**
 * The zero-padded set index an `Observation` id ends in: at least two digits,
 * and as many as the exercise's last set needs, so every set id of the
 * exercise has one width and sorts in set order.
 */
const setIndexPartOf = ({
  setIndex,
  sets,
}: {
  readonly setIndex: number
  readonly sets: number
}): string => {
  const width = Math.max(2, String(Math.max(sets - 1, 0)).length)
  return String(setIndex).padStart(width, '0')
}

/**
 * An exercise id cut to `maxLength` characters: as it is when it fits, or
 * its head and the hex FNV-1a hash of the whole id, so two long ids that
 * share a head stay apart (the hash alone when there is no room for a head).
 */
const exerciseIdPartOf = ({
  exerciseId,
  maxLength,
}: {
  readonly exerciseId: string
  readonly maxLength: number
}): string => {
  if (exerciseId.length <= maxLength) return exerciseId
  const hash = fnv1a64(exerciseId).toString(16).padStart(16, '0')
  const head = exerciseId.slice(0, Math.max(maxLength - hash.length - 1, 0))
  return head === '' ? hash.slice(0, maxLength) : `${head}-${hash}`
}

/**
 * The `Observation` id of one set: `<procedureId>-<exerciseId>-<setIndex>`,
 * the set index zero-padded ({@link setIndexPartOf}) and the exercise id cut
 * to fit 64 characters ({@link exerciseIdPartOf}).
 *
 * @remarks
 * A workout's sets tie on start, so `ExerciseSetObservation.sortByStart`
 * orders them by id: the sets of one exercise in one workout share
 * everything up to the set index, so their ids sort in set order.
 */
const exerciseSetObservationIdOf = ({
  procedureId,
  exerciseId,
  setIndex,
  sets,
}: {
  readonly procedureId: string
  readonly exerciseId: string
  readonly setIndex: number
  readonly sets: number
}): string => {
  const setIndexPart = setIndexPartOf({ setIndex, sets })
  return [
    procedureId,
    exerciseIdPartOf({
      exerciseId,
      maxLength: FHIR_ID_MAX_LENGTH - procedureId.length - setIndexPart.length - 2,
    }),
    setIndexPart,
  ].join('-')
}

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

/**
 * The `mintServiceRequestId` for one start of a training plan definition: an
 * id minted the first time an exercise asks for one, then remembered, so a
 * retry names the same `ServiceRequest`s.
 */
const serviceRequestIdMinter = (): ((exerciseId: string) => string) => {
  const mintedIds = new Map<string, string>()
  return (exerciseId) => {
    const known = mintedIds.get(exerciseId)
    if (known !== undefined) return known
    const minted = mintResourceId()
    mintedIds.set(exerciseId, minted)
    return minted
  }
}

export {
  exerciseSetObservationIdOf,
  FHIR_ID_MAX_LENGTH,
  mintResourceId,
  serviceRequestIdMinter,
  workoutIdMinter,
}
