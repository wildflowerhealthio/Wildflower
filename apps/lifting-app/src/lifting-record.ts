import { Array as Arr, Effect, Option, Schema } from 'effect'
import {
  type BundleDecodeError,
  fetchActiveServiceRequestPage,
  fetchAllResourcePages,
  fetchObservationBasedOnOrPartOfPage,
  fetchPlanDefinitionPage,
  fetchProcedurePage,
  fetchServiceRequestPage,
  type ObservationBasedOnOrPartOfFirstPage,
  type ObservationResource,
  type ResourcePage,
  type ResourcePageCycleError,
  type ResourcePageRequestError,
} from 'fhir-r4-react/smart'
import { Observation } from 'fhir-r4/resources'
import {
  ExerciseRequest,
  ExerciseSetObservation,
  LiftingFeature,
  TrainingPlanDefinition,
  WorkoutProcedure,
} from 'lifting-core'

import type { SmartClient } from './smart-client.ts'

/**
 * Reading a lifter's record off the FHIR server: every page of each search,
 * each resource decoded into `lifting-core`'s narrowed type, and every
 * resource that did not decode counted rather than dropped in silence.
 *
 * @packageDocumentation
 */

/** A failed read: a page request, a page that is not a bundle, or a `next` link that loops. */
type ReadFailure = ResourcePageRequestError | BundleDecodeError | ResourcePageCycleError

/**
 * How many resources of each lifting type a read found but could not use:
 * entries that did not decode as the FHIR resource, and resources that did
 * but are not the lifting type (`lifting-core`'s `Schema` refused them).
 */
interface UnreadableCounts {
  readonly trainingPlanDefinitions: number
  readonly exerciseRequests: number
  readonly workoutProcedures: number
  readonly exerciseSetObservations: number
}

const NO_UNREADABLE: UnreadableCounts = {
  trainingPlanDefinitions: 0,
  exerciseRequests: 0,
  workoutProcedures: 0,
  exerciseSetObservations: 0,
}

/** The resources a whole read decoded as the lifting type, and how many it could not. */
interface DecodedResources<A> {
  readonly resources: readonly A[]
  readonly unreadableCount: number
}

/**
 * Decode every resource of a whole read through a lifting `Schema`, counting
 * the page entries that did not decode as FHIR beside the resources the
 * schema refused.
 */
const decodeEvery = <A, I>(
  schema: Schema.Schema<A, I>,
  read: Omit<ResourcePage<I>, 'nextPageUrl'>
): DecodedResources<A> => {
  const decode = Schema.decodeEither(schema)
  const [refused, resources] = Arr.partitionMap(read.items, (item) => decode(item))
  return { resources, unreadableCount: refused.length + read.droppedEntryCount }
}

/**
 * The sets of a whole `Observation` read: retracted observations left out
 * before decoding — withdrawn, not unreadable — and the rest decoded as
 * {@link decodeEvery} decodes.
 */
const decodeExerciseSetObservations = (
  read: Omit<ResourcePage<ObservationResource>, 'nextPageUrl'>
): DecodedResources<ExerciseSetObservation.Type> =>
  decodeEvery(ExerciseSetObservation.Schema, {
    ...read,
    items: read.items.filter(
      (observation) => !Observation.RETRACTED_STATUSES.has(observation.status)
    ),
  })

/** Every page of the sets one first page names, over `client`. */
const fetchEveryObservation = (
  client: SmartClient,
  first: ObservationBasedOnOrPartOfFirstPage
): Effect.Effect<Omit<ResourcePage<ObservationResource>, 'nextPageUrl'>, ReadFailure> =>
  fetchAllResourcePages((cursor) => fetchObservationBasedOnOrPartOfPage(client, cursor), first)

/**
 * How many per-resource searches run at once: one per active
 * `ExerciseRequest` (a handful) or per completed workout (a history's worth).
 */
const SEARCH_CONCURRENCY = 4

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

export {
  type CurrentTraining,
  readTrainingRecord,
  readWorkoutHistory,
  type ReadFailure,
  type TrainingRecord,
  type UnreadableCounts,
  type WorkoutHistory,
}
