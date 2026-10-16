import { fnv1a64 } from '@wildflowerhealthio/kitchen-sink'

/** The longest id FHIR R4 allows: an `id` is `[A-Za-z0-9\-\.]{1,64}`. */
const FHIR_ID_MAX_LENGTH = 64

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

export { exerciseSetObservationIdOf, FHIR_ID_MAX_LENGTH }
