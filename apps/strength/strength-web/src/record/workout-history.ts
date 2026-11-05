import {
  fetchAllResourcePages,
  fetchProcedurePage,
  fetchServiceRequestPage,
  type SmartClient,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import {
  ExerciseRequest,
  type ExerciseSetObservation,
  StrengthFeature,
  WorkoutProcedure,
} from '@wildflowerhealthio/strength-core-js'
import { Array as Arr, Effect } from 'effect'

import {
  decodeEvery,
  decodeExerciseSetObservations,
  fetchEveryObservation,
  type ReadFailure,
  SEARCH_CONCURRENCY,
} from './read-every-page.ts'
import { NO_UNREADABLE, type UnreadableCounts } from './unreadable-counts.ts'

/**
 * Every completed workout the lifter performed, under any training plan
 * definition, with its sets and the `ExerciseRequest`s it carried out —
 * everything `WorkoutHistoryView` takes.
 */
interface WorkoutHistory {
  /** Every lifting `ExerciseRequest`, closed ones too. */
  readonly exerciseRequests: readonly ExerciseRequest.Type[]
  readonly workoutProcedures: readonly WorkoutProcedure.Type[]
  readonly exerciseSetObservations: readonly ExerciseSetObservation.Type[]
  readonly unreadable: UnreadableCounts
}

/**
 * Read the lifter's whole workout history: every lifting `ExerciseRequest` in
 * any status and every workout, then the sets `part-of` each completed one.
 * `patientId` `null` reads every patient's, unscoped.
 *
 * @remarks
 * One set search per completed workout — the groups the history shows. A
 * workout still in progress is passed over by the view, so its sets are not
 * read.
 */
const readWorkoutHistory = (
  patientId: string | null
): Effect.Effect<WorkoutHistory, ReadFailure, SmartClient> =>
  Effect.gen(function* () {
    const [serviceRequests, procedures] = yield* Effect.all(
      [
        fetchAllResourcePages(fetchServiceRequestPage, {
          patientId,
          categoryToken: StrengthFeature.TOKEN,
          instantiatesCanonicalUrl: null,
        }),
        fetchAllResourcePages(fetchProcedurePage, {
          patientId,
          categoryToken: StrengthFeature.TOKEN,
          instantiatesCanonicalUrl: null,
        }),
      ],
      { concurrency: 'unbounded' }
    )
    const exerciseRequests = decodeEvery(ExerciseRequest.Schema, serviceRequests)
    const workoutProcedures = decodeEvery(WorkoutProcedure.Schema, procedures)
    const exerciseSetObservationReads = yield* Effect.forEach(
      workoutProcedures.resources.filter(WorkoutProcedure.isCompleted),
      (workoutProcedure) =>
        fetchEveryObservation({
          patientId,
          basedOnReference: null,
          partOfReference: `Procedure/${workoutProcedure.id}`,
        }),
      { concurrency: SEARCH_CONCURRENCY }
    )
    const exerciseSetObservations = exerciseSetObservationReads.map(decodeExerciseSetObservations)
    return {
      exerciseRequests: exerciseRequests.resources,
      workoutProcedures: workoutProcedures.resources,
      exerciseSetObservations: exerciseSetObservations.flatMap(({ resources }) => resources),
      unreadable: {
        ...NO_UNREADABLE,
        exerciseRequests: exerciseRequests.unreadableCount,
        workoutProcedures: workoutProcedures.unreadableCount,
        exerciseSetObservations: Arr.reduce(
          exerciseSetObservations,
          0,
          (total, { unreadableCount }) => total + unreadableCount
        ),
      },
    }
  })

export { readWorkoutHistory, type WorkoutHistory }
