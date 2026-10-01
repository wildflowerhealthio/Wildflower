import { Array as Arr, Effect } from 'effect'
import {
  fetchAllResourcePages,
  fetchProcedurePage,
  fetchServiceRequestPage,
} from 'fhir-r4-react/smart'
import {
  ExerciseRequest,
  type ExerciseSetObservation,
  LiftingFeature,
  WorkoutProcedure,
} from 'lifting-core'

import type { SmartClient } from '../smart-client.ts'
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
 *
 * @remarks
 * One set search per completed workout — the groups the history shows. A
 * workout still in progress is passed over by the view, so its sets are not
 * read.
 */
const readWorkoutHistory = (
  client: SmartClient,
  patientId: string
): Effect.Effect<WorkoutHistory, ReadFailure> =>
  Effect.gen(function* () {
    const [serviceRequests, procedures] = yield* Effect.all(
      [
        fetchAllResourcePages((cursor) => fetchServiceRequestPage(client, cursor), {
          patientId,
          categoryToken: LiftingFeature.TOKEN,
          instantiatesCanonicalUrl: null,
        }),
        fetchAllResourcePages((cursor) => fetchProcedurePage(client, cursor), {
          patientId,
          categoryToken: LiftingFeature.TOKEN,
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
        fetchEveryObservation(client, {
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
