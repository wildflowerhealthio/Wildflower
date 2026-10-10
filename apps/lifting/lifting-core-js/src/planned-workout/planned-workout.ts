import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  Array as Arr,
  Data,
  type DateTime,
  Either,
  Option,
  type ParseResult,
  pipe,
  Record as EffectRecord,
} from 'effect'

import * as ExerciseRequest from '../exercise-request/exercise-request.ts'
import * as ExerciseSetObservation from '../exercise-set-observation/exercise-set-observation.ts'
import * as ExerciseConcept from '../exercise/exercise-concept.ts'
import * as TrainingPlanDefinition from '../training-plan-definition/training-plan-definition.ts'
import * as WorkoutProcedure from '../workout-procedure/workout-procedure.ts'

/**
 * One exercise of a planned workout: its exercise (definition) on the day,
 * the lifter's active `ExerciseRequest` at it, and the attempts at that
 * `ExerciseRequest` so far.
 */
interface PlannedWorkoutExercise {
  /** How the training plan definition runs the exercise, and the rule its load moves by. */
  readonly trainingPlanDefinitionExercise: TrainingPlanDefinition.Exercise.Type
  /** The load, sets and reps to perform; see `ExerciseRequest.loadOf`, `setsOf`, `repsOf`. */
  readonly exerciseRequest: ExerciseRequest.Type
  /** The attempts at `exerciseRequest` before this workout, earliest first, as `ExerciseRequest.attemptsAt` lists them. */
  readonly attempts: readonly ExerciseRequest.Attempt[]
}

/**
 * The workout due next — what the "today" screen shows: the next day of a
 * training plan definition and, for each exercise on it, the lifter's
 * active `ExerciseRequest` at it.
 *
 * @remarks
 * Derived from the training plan definition, the active `ExerciseRequest`s
 * and the workouts and sets performed, never stored: nothing is written
 * until {@link submit}.
 */
interface PlannedWorkout {
  /** The training plan definition the workout performs a day of. */
  readonly trainingPlanDefinition: TrainingPlanDefinition.Type
  /** The day due, as `TrainingPlanDefinition.nextDay` finds it. */
  readonly trainingPlanDefinitionDay: TrainingPlanDefinition.Day.Type
  /** Each exercise the day runs, once, in the order it first runs it. */
  readonly plannedWorkoutExercises: readonly PlannedWorkoutExercise[]
}

/** An exercise of the day due, by id, and the ids of the active `ServiceRequest`s at it. */
interface ExerciseAndServiceRequestIds {
  readonly exerciseId: string
  /** None, or several. */
  readonly serviceRequestIds: readonly string[]
}

/**
 * `PlannedWorkout.make` found exercises of the day due with no active
 * `ExerciseRequest` of the training plan definition, or several, listing
 * every one of them.
 *
 * @remarks
 * A tagged error rather than a schema refinement: it relates the training
 * plan definition to the `ServiceRequest`s, which no single value's schema
 * can see. Start a training plan definition with
 * `ExerciseRequest.makeForEachExercise`, and the one for an exercise an
 * edit added with `ExerciseRequest.make`.
 */
class ExerciseNotRequestedOnce extends Data.TaggedError('ExerciseNotRequestedOnce')<{
  /** Every exercise of the day with no active `ExerciseRequest` or several, in the day's order. */
  readonly exercises: Arr.NonEmptyReadonlyArray<ExerciseAndServiceRequestIds>
  /** The label of the day due. */
  readonly dayLabel: string
  /** The canonical url of the training plan definition. */
  readonly trainingPlanDefinitionUrl: string
}> {
  // Data.TaggedError leaves `.message` empty by default; name the exercises so
  // a logged or thrown refusal says what was wrong.
  override get message(): string {
    const described = this.exercises.map(({ exerciseId, serviceRequestIds }) =>
      serviceRequestIds.length === 0
        ? `${JSON.stringify(exerciseId)} has none`
        : `${JSON.stringify(exerciseId)} has ${serviceRequestIds.map((id) => JSON.stringify(id)).join(', ')}`
    )
    return `day ${JSON.stringify(this.dayLabel)} of the training plan definition ${this.trainingPlanDefinitionUrl} needs exactly one active ExerciseRequest per exercise: ${described.join('; ')}`
  }
}

/**
 * The workout due next under `trainingPlanDefinition`: the day after the one
 * the latest completed workout under it performed
 * (`TrainingPlanDefinition.nextDay`) and, for each exercise of that day, its
 * one active `ExerciseRequest` of the training plan definition and the
 * attempts at it.
 *
 * @param inputs - The training plan definition; the lifter's
 *   `ExerciseRequest`s (closed ones, and those of another training plan
 *   definition, are passed over); and the lifter's workouts and sets, in any
 *   order (workouts of another training plan definition are passed over)
 * @returns The planned workout; or {@link ExerciseNotRequestedOnce} listing
 *   every exercise of the day with no active `ExerciseRequest`, or several
 *
 * @remarks
 * An exercise a day runs twice is planned once.
 */
const make = (inputs: {
  readonly trainingPlanDefinition: TrainingPlanDefinition.Type
  readonly exerciseRequests: readonly ExerciseRequest.Type[]
  readonly workoutProcedures: readonly WorkoutProcedure.Type[]
  readonly exerciseSetObservations: readonly ExerciseSetObservation.Type[]
}): Either.Either<PlannedWorkout, ExerciseNotRequestedOnce> => {
  const { trainingPlanDefinition } = inputs
  const workoutProcedures = inputs.workoutProcedures.filter(
    (workoutProcedure) =>
      WorkoutProcedure.trainingPlanDefinitionUrlOf(workoutProcedure) === trainingPlanDefinition.url
  )
  const trainingPlanDefinitionDay = TrainingPlanDefinition.nextDay({
    trainingPlanDefinition,
    latestCompletedWorkoutProcedure: WorkoutProcedure.latestCompleted(workoutProcedures),
  })
  const activeExerciseRequests = inputs.exerciseRequests.filter(
    (exerciseRequest) =>
      exerciseRequest.status === 'active' &&
      ExerciseRequest.trainingPlanDefinitionUrlOf(exerciseRequest) === trainingPlanDefinition.url
  )
  const [notRequestedOnce, plannedWorkoutExercises] = Arr.partitionMap(
    Arr.dedupeWith(
      TrainingPlanDefinition.Day.exercisesOf(trainingPlanDefinitionDay),
      (left, right) =>
        TrainingPlanDefinition.Exercise.exerciseIdOf(left) ===
        TrainingPlanDefinition.Exercise.exerciseIdOf(right)
    ),
    (trainingPlanDefinitionExercise) => {
      const exerciseId = TrainingPlanDefinition.Exercise.exerciseIdOf(
        trainingPlanDefinitionExercise
      )
      const exerciseRequests = activeExerciseRequests.filter(
        (exerciseRequest) =>
          ExerciseConcept.idOf(ExerciseRequest.exerciseOf(exerciseRequest)) === exerciseId
      )
      return pipe(
        Arr.head(exerciseRequests),
        Option.filter(() => exerciseRequests.length === 1),
        Option.match({
          onNone: () =>
            Either.left<ExerciseAndServiceRequestIds>({
              exerciseId,
              serviceRequestIds: exerciseRequests.map((exerciseRequest) => exerciseRequest.id),
            }),
          onSome: (exerciseRequest) =>
            Either.right<PlannedWorkoutExercise>({
              trainingPlanDefinitionExercise,
              exerciseRequest,
              attempts: ExerciseRequest.attemptsAt(exerciseRequest, {
                workoutProcedures,
                exerciseSetObservations: inputs.exerciseSetObservations,
              }),
            }),
        })
      )
    }
  )
  if (Arr.isNonEmptyReadonlyArray(notRequestedOnce))
    return Either.left(
      new ExerciseNotRequestedOnce({
        exercises: notRequestedOnce,
        dayLabel: TrainingPlanDefinition.Day.labelOf(trainingPlanDefinitionDay),
        trainingPlanDefinitionUrl: trainingPlanDefinition.url,
      })
    )
  return Either.right({
    trainingPlanDefinition,
    trainingPlanDefinitionDay,
    plannedWorkoutExercises,
  })
}

/**
 * How many of the latest attempts at the exercise failed in a row — the N of
 * "failure N of M" (`ExerciseRequest.consecutiveFailures`).
 */
const consecutiveFailuresOf = (plannedWorkoutExercise: PlannedWorkoutExercise): number =>
  ExerciseRequest.consecutiveFailures(
    plannedWorkoutExercise.exerciseRequest,
    plannedWorkoutExercise.attempts
  )

/**
 * How many failures in a row the exercise's rule waits for before a deload —
 * the M of "failure N of M".
 */
const failuresBeforeDeloadOf = (plannedWorkoutExercise: PlannedWorkoutExercise): number =>
  TrainingPlanDefinition.ProgressionRule.failuresBeforeDeloadOf(
    TrainingPlanDefinition.Exercise.progressionRuleOf(
      plannedWorkoutExercise.trainingPlanDefinitionExercise
    )
  )

/** The id of the exercise, from its exercise (definition). */
const exerciseIdOf = (plannedWorkoutExercise: PlannedWorkoutExercise): string =>
  TrainingPlanDefinition.Exercise.exerciseIdOf(
    plannedWorkoutExercise.trainingPlanDefinitionExercise
  )

/**
 * A resource {@link submit} writes, for the app to mint its id: the workout
 * `Procedure`; the `Observation` of the set at `setIndex` (from 0, in the
 * order entered) of an exercise, whose ids must sort in `setIndex` order
 * (see {@link submit}); or the next `ServiceRequest` at an exercise with sets
 * entered, used only when its load moves.
 */
type IdToMint =
  | { readonly resourceType: 'Procedure' }
  | { readonly resourceType: 'Observation'; readonly exerciseId: string; readonly setIndex: number }
  | { readonly resourceType: 'ServiceRequest'; readonly exerciseId: string }

/** Reps per set entered for each exercise, by exercise id, in the order performed. */
type SetRepsByExerciseId = EffectRecord.ReadonlyRecord<string, readonly number[]>

/**
 * {@link submit} was given reps for exercises the planned workout does not
 * run, listing every one of them — reps that would otherwise be dropped.
 */
class ExerciseNotInPlannedWorkout extends Data.TaggedError('ExerciseNotInPlannedWorkout')<{
  /** The ids of every exercise reps were entered for that the day does not run. */
  readonly exerciseIds: Arr.NonEmptyReadonlyArray<string>
  /** The label of the day planned. */
  readonly dayLabel: string
}> {
  // Data.TaggedError leaves `.message` empty by default; name the exercises so
  // a logged or thrown refusal says what was wrong.
  override get message(): string {
    return `day ${JSON.stringify(this.dayLabel)} does not run the exercises ${this.exerciseIds.map((id) => JSON.stringify(id)).join(', ')}`
  }
}

/** Everything {@link submit} writes. */
interface Submitted {
  /** The workout, `completed`. */
  readonly workoutProcedure: WorkoutProcedure.Type
  /** One per set entered, exercise by exercise in the day's order, each in the order entered. */
  readonly exerciseSetObservations: readonly ExerciseSetObservation.Type[]
  /**
   * The progression of each exercise's `ExerciseRequest`, in the day's order:
   * write `current` and the `next` one unless the decision is a hold.
   */
  readonly exerciseRequestProgresses: readonly ExerciseRequest.Progress[]
}

/**
 * One exercise of a submitted workout: its sets made against its
 * `ExerciseRequest` in the completed `workoutProcedure`, and the
 * `ExerciseRequest` progressed over its attempts and these sets — or left as
 * a hold when no set was entered.
 *
 * @remarks
 * `ExerciseRequest.progress` runs over the attempts before this workout and
 * this one: they are the only attempts at the `ExerciseRequest`, so the rest
 * of the lifter's history cannot change the decision.
 */
const submitExercise = ({
  plannedWorkoutExercise,
  workoutProcedure,
  start,
  end,
  setRepsByExerciseId,
  mintId,
}: {
  readonly plannedWorkoutExercise: PlannedWorkoutExercise
  readonly workoutProcedure: WorkoutProcedure.Type
  readonly start: DateTime.Utc
  readonly end: DateTime.Utc
  readonly setRepsByExerciseId: SetRepsByExerciseId
  readonly mintId: (idToMint: IdToMint) => string
}): Either.Either<
  {
    readonly exerciseSetObservations: readonly ExerciseSetObservation.Type[]
    readonly exerciseRequestProgress: ExerciseRequest.Progress
  },
  ParseResult.ParseError
> => {
  const { exerciseRequest, trainingPlanDefinitionExercise, attempts } = plannedWorkoutExercise
  const exerciseId = exerciseIdOf(plannedWorkoutExercise)
  const setReps = Option.getOrElse(
    EffectRecord.get(setRepsByExerciseId, exerciseId),
    (): readonly number[] => []
  )
  return pipe(
    Either.all(
      setReps.map((reps, setIndex) =>
        ExerciseSetObservation.make({
          observationId: mintId({ resourceType: 'Observation', exerciseId, setIndex }),
          exerciseRequest,
          workoutProcedure,
          start,
          end,
          reps,
        })
      )
    ),
    Either.flatMap((exerciseSetObservations) =>
      Arr.isEmptyReadonlyArray(exerciseSetObservations)
        ? Either.right({
            exerciseSetObservations,
            exerciseRequestProgress: {
              decision: 'hold' as const,
              current: exerciseRequest,
              next: Option.none(),
            },
          })
        : Either.map(
            ExerciseRequest.progress({
              exerciseRequest,
              progressionRule: TrainingPlanDefinition.Exercise.progressionRuleOf(
                trainingPlanDefinitionExercise
              ),
              workoutProcedures: [
                ...attempts.map((attempt) => attempt.workoutProcedure),
                workoutProcedure,
              ],
              exerciseSetObservations: [
                ...attempts.flatMap((attempt) => attempt.exerciseSetObservations),
                ...exerciseSetObservations,
              ],
              nextServiceRequestId: mintId({ resourceType: 'ServiceRequest', exerciseId }),
              authoredOn: end,
            }),
            (exerciseRequestProgress) => ({ exerciseSetObservations, exerciseRequestProgress })
          )
    )
  )
}

/**
 * The planned workout performed and done, as one submission: the completed
 * `WorkoutProcedure`, an `ExerciseSetObservation` per set entered, and each
 * exercise's `ExerciseRequest` progressed over its attempts and this one.
 *
 * @param submission - The planned workout; the lifter as `subject`; when the
 *   workout started and ended; the reps of each set entered, by exercise id;
 *   and `mintId`, which names the id of each resource written (see
 *   {@link IdToMint}) — return the same id for the same resource on a retry,
 *   so writing again overwrites rather than duplicates
 * @returns What to write; {@link ExerciseNotInPlannedWorkout} listing every
 *   exercise reps were entered for that the day does not run; or a
 *   `ParseError` when `end` is before `start`, a set's reps are not a
 *   non-negative integer, or a load is in a unit its rule does not move. A
 *   planned workout {@link make} did not make may also be refused as
 *   `WorkoutProcedure.make` refuses one.
 *
 * @remarks
 * Sets are not timed one by one: each set's `effectivePeriod` is the
 * workout's span, `start` to `end`, so sets of one workout tie on start and
 * `ExerciseSetObservation.sortByStart` orders them by `id`. Mint the
 * `Observation` ids of an exercise so they sort in `setIndex` order (a
 * zero-padded index), or a later read judges its sets in another order.
 *
 * An exercise with no set entered is no attempt at it: its `ExerciseRequest`
 * is left untouched, a hold with nothing written, whatever its earlier
 * attempts say. The workout still completes the day, so the next one planned
 * is the day after. Each next `ExerciseRequest` is issued at `end`.
 */
const submit = ({
  plannedWorkout,
  subject,
  start,
  end,
  setRepsByExerciseId,
  mintId,
}: {
  readonly plannedWorkout: PlannedWorkout
  readonly subject: IdentifierAndReference.ReferenceType
  readonly start: DateTime.Utc
  readonly end: DateTime.Utc
  readonly setRepsByExerciseId: SetRepsByExerciseId
  readonly mintId: (idToMint: IdToMint) => string
}): Either.Either<
  Submitted,
  | ExerciseNotInPlannedWorkout
  | WorkoutProcedure.DayNotInTrainingPlanDefinition
  | WorkoutProcedure.ExerciseRequestNotOfTrainingPlanDefinition
  | ParseResult.ParseError
> => {
  const { trainingPlanDefinition, trainingPlanDefinitionDay, plannedWorkoutExercises } =
    plannedWorkout
  const plannedExerciseIds = plannedWorkoutExercises.map(exerciseIdOf)
  const strayExerciseIds = Object.keys(setRepsByExerciseId).filter(
    (exerciseId) => !plannedExerciseIds.includes(exerciseId)
  )
  if (Arr.isNonEmptyReadonlyArray(strayExerciseIds))
    return Either.left(
      new ExerciseNotInPlannedWorkout({
        exerciseIds: strayExerciseIds,
        dayLabel: TrainingPlanDefinition.Day.labelOf(trainingPlanDefinitionDay),
      })
    )
  return pipe(
    WorkoutProcedure.make({
      procedureId: mintId({ resourceType: 'Procedure' }),
      subject,
      trainingPlanDefinition,
      trainingPlanDefinitionDay,
      exerciseRequests: plannedWorkoutExercises.map(({ exerciseRequest }) => exerciseRequest),
      start,
    }),
    Either.flatMap((startedWorkoutProcedure) =>
      WorkoutProcedure.complete(startedWorkoutProcedure, end)
    ),
    Either.flatMap((workoutProcedure) =>
      pipe(
        Either.all(
          Arr.map(plannedWorkoutExercises, (plannedWorkoutExercise) =>
            submitExercise({
              plannedWorkoutExercise,
              workoutProcedure,
              start,
              end,
              setRepsByExerciseId,
              mintId,
            })
          )
        ),
        Either.map((submittedExercises): Submitted => ({
          workoutProcedure,
          exerciseSetObservations: submittedExercises.flatMap(
            ({ exerciseSetObservations }) => exerciseSetObservations
          ),
          exerciseRequestProgresses: Arr.map(
            submittedExercises,
            ({ exerciseRequestProgress }) => exerciseRequestProgress
          ),
        }))
      )
    )
  )
}

export {
  consecutiveFailuresOf,
  ExerciseNotInPlannedWorkout,
  ExerciseNotRequestedOnce,
  exerciseIdOf,
  failuresBeforeDeloadOf,
  make,
  submit,
}
export type {
  ExerciseAndServiceRequestIds,
  IdToMint,
  PlannedWorkout as Type,
  PlannedWorkoutExercise as Exercise,
  SetRepsByExerciseId,
  Submitted,
}
