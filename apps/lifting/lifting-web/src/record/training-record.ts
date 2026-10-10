import {
  fetchActiveServiceRequestPage,
  fetchAllResourcePages,
  fetchPlanDefinitionPage,
  fetchProcedurePage,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import {
  ExerciseRequest,
  type ExerciseSetObservation,
  LiftingFeature,
  TrainingPlanDefinition,
  WorkoutProcedure,
} from '@wildflowerhealthio/lifting-core-js'
import { Array as Arr, Effect, Option } from 'effect'

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
 * The lifter's current program: the training plan definition their active
 * `ExerciseRequest`s instantiate, those requests, the workouts performed under
 * it, and the sets logged against the active requests — everything
 * `PlannedWorkout.make` takes.
 */
interface CurrentTraining {
  readonly trainingPlanDefinition: TrainingPlanDefinition.Type
  /** The active `ExerciseRequest`s of the training plan definition. */
  readonly exerciseRequests: readonly ExerciseRequest.Type[]
  /** Every workout under the training plan definition, in server order. */
  readonly workoutProcedures: readonly WorkoutProcedure.Type[]
  /** The sets logged against the active `ExerciseRequest`s: the attempts at them. */
  readonly exerciseSetObservations: readonly ExerciseSetObservation.Type[]
}

/**
 * What the app opens on: the lifter's active `ExerciseRequest`s and the
 * program they follow, or none.
 */
interface TrainingRecord {
  /** Every active `ExerciseRequest` that decoded, of every training plan definition. */
  readonly activeExerciseRequests: readonly ExerciseRequest.Type[]
  /**
   * The current program; `None` when no `ExerciseRequest` is active, or when
   * the training plan definition they instantiate was not found
   * ({@link TrainingRecord.missingTrainingPlanDefinitionUrl}).
   */
  readonly current: Option.Option<CurrentTraining>
  /** The url the active `ExerciseRequest`s instantiate when no readable `PlanDefinition` carries it. */
  readonly missingTrainingPlanDefinitionUrl: Option.Option<string>
  /** Active `ExerciseRequest`s of another training plan definition than the current one. */
  readonly otherActiveExerciseRequestCount: number
  readonly unreadable: UnreadableCounts
}

/**
 * The url of the training plan definition the lifter follows: the one the
 * latest-authored active `ExerciseRequest` instantiates (the read returns them
 * oldest-authored first), or `None` when none is active.
 */
const currentTrainingPlanDefinitionUrlOf = (
  activeExerciseRequests: readonly ExerciseRequest.Type[]
): Option.Option<string> =>
  Option.map(Arr.last(activeExerciseRequests), ExerciseRequest.trainingPlanDefinitionUrlOf)

/**
 * Read what the app opens on for `patientId`: their active lifting
 * `ExerciseRequest`s and, when there are any, the training plan definition
 * they instantiate (searched by `topic`, picked by `url`), the workouts under
 * it, and the sets logged against each active request.
 *
 * @remarks
 * Sets are searched `based-on` each active `ExerciseRequest` — one search per
 * exercise of the program, however long the history — because the attempts at
 * those requests are all `PlannedWorkout.make` judges. Searching `part-of`
 * each workout would grow a search per workout ever performed.
 *
 * Every page is read: the day due and each "failure N of M" are decided over
 * the whole record, so a partial read would get them wrong.
 */
const readTrainingRecord = (
  client: SmartClient,
  patientId: string
): Effect.Effect<TrainingRecord, ReadFailure> =>
  Effect.gen(function* () {
    const serviceRequests = yield* fetchAllResourcePages(
      (cursor) => fetchActiveServiceRequestPage(client, cursor),
      { patientId, categoryToken: LiftingFeature.TOKEN, instantiatesCanonicalUrl: null }
    )
    const activeExerciseRequests = decodeEvery(ExerciseRequest.Schema, serviceRequests)
    const unreadableRequests = {
      ...NO_UNREADABLE,
      exerciseRequests: activeExerciseRequests.unreadableCount,
    }
    const notStarted: TrainingRecord = {
      activeExerciseRequests: activeExerciseRequests.resources,
      current: Option.none(),
      missingTrainingPlanDefinitionUrl: Option.none(),
      otherActiveExerciseRequestCount: 0,
      unreadable: unreadableRequests,
    }
    const currentUrl = currentTrainingPlanDefinitionUrlOf(activeExerciseRequests.resources)
    if (Option.isNone(currentUrl)) return notStarted
    const trainingPlanDefinitionUrl = currentUrl.value

    const [otherExerciseRequests, exerciseRequests] = Arr.partition(
      activeExerciseRequests.resources,
      (exerciseRequest) =>
        ExerciseRequest.trainingPlanDefinitionUrlOf(exerciseRequest) === trainingPlanDefinitionUrl
    )
    const [planDefinitions, procedures, exerciseSetObservationReads] = yield* Effect.all(
      [
        fetchAllResourcePages((cursor) => fetchPlanDefinitionPage(client, cursor), {
          topicToken: LiftingFeature.TOKEN,
        }),
        fetchAllResourcePages((cursor) => fetchProcedurePage(client, cursor), {
          patientId,
          categoryToken: LiftingFeature.TOKEN,
          instantiatesCanonicalUrl: trainingPlanDefinitionUrl,
        }),
        Effect.forEach(
          exerciseRequests,
          (exerciseRequest) =>
            fetchEveryObservation(client, {
              patientId,
              basedOnReference: `ServiceRequest/${exerciseRequest.id}`,
              partOfReference: null,
            }),
          { concurrency: SEARCH_CONCURRENCY }
        ),
      ],
      { concurrency: 'unbounded' }
    )
    const trainingPlanDefinitions = decodeEvery(TrainingPlanDefinition.Schema, planDefinitions)
    const workoutProcedures = decodeEvery(WorkoutProcedure.Schema, procedures)
    const exerciseSetObservations = exerciseSetObservationReads.map(decodeExerciseSetObservations)
    const unreadable: UnreadableCounts = {
      ...unreadableRequests,
      trainingPlanDefinitions: trainingPlanDefinitions.unreadableCount,
      workoutProcedures: workoutProcedures.unreadableCount,
      exerciseSetObservations: Arr.reduce(
        exerciseSetObservations,
        0,
        (total, { unreadableCount }) => total + unreadableCount
      ),
    }
    const trainingPlanDefinition = Arr.findFirst(
      trainingPlanDefinitions.resources,
      ({ url }) => url === trainingPlanDefinitionUrl
    )
    return {
      activeExerciseRequests: activeExerciseRequests.resources,
      current: Option.map(trainingPlanDefinition, (found): CurrentTraining => ({
        trainingPlanDefinition: found,
        exerciseRequests,
        workoutProcedures: workoutProcedures.resources,
        exerciseSetObservations: exerciseSetObservations.flatMap(({ resources }) => resources),
      })),
      missingTrainingPlanDefinitionUrl: Option.isNone(trainingPlanDefinition)
        ? currentUrl
        : Option.none(),
      otherActiveExerciseRequestCount: otherExerciseRequests.length,
      unreadable,
    }
  })

export { type CurrentTraining, readTrainingRecord, type TrainingRecord }
