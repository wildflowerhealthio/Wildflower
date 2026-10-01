import {
  Array as Arr,
  type Brand,
  Data,
  DateTime,
  Either,
  Option,
  type ParseResult,
  pipe,
  Record as EffectRecord,
  Schema,
} from 'effect'
import {
  CodeableConcept,
  IdentifierAndReference,
  narrowFields,
  withMandatoryId,
} from 'fhir-r4/data-types'
import { ServiceRequest } from 'fhir-r4/resources'

import {
  countExerciseParameterAmong,
  countExerciseParameterConcept,
  loadExerciseParameterAmong,
  loadExerciseParameterConcept,
  checkArrayHasOneExerciseParameter,
  isExerciseParameterConcept,
} from '../exercise-parameter/exercise-parameter-concept.ts'
import * as ExerciseParameter from '../exercise-parameter/exercise-parameter.ts'
import * as ExerciseSetObservation from '../exercise-set-observation/exercise-set-observation.ts'
import * as ExerciseConcept from '../exercise/exercise-concept.ts'
import { filterArrayWithEveryCheck } from '../internal/filter-array-with-every-check.ts'
import { narrowedFrom } from '../internal/narrowed-from.ts'
import * as LiftingFeature from '../lifting-feature/lifting-feature.ts'
import * as Load from '../load/load.ts'
import * as TrainingPlanDefinition from '../training-plan-definition/training-plan-definition.ts'
import * as WorkoutProcedure from '../workout-procedure/workout-procedure.ts'

/**
 * What a lifter is to do at one exercise until it moves, as FHIR orders it: a
 * `ServiceRequest` whose service is an exercise, narrowed to an `id`, an
 * {@link ExerciseConcept.Type} as its `code`, exactly one
 * `instantiatesCanonical` — the url of the training plan definition it
 * follows — and exactly one
 * `load`, one `sets` and one `reps` `orderDetail`, each carrying its value in
 * range: lift the load for sets × reps.
 *
 * @remarks
 * Each one is one load: a met workout closes it (`completed`) and issues the
 * next one heavier, a deload closes it (`revoked`) and issues the next one
 * lighter, and a change of program revokes them all. It carries no rule:
 * how its load moves is the training plan definition's, on its exercise
 * (definition) for the same exercise. Its `status` is not narrowed — the app
 * searches `status=active`. Other order details ride along untouched.
 */
interface Type
  extends
    Omit<ServiceRequest.Type, 'id' | 'code' | 'instantiatesCanonical'>,
    Brand.Brand<'ExerciseRequest'> {
  /** The id the `ServiceRequest` is stored under. */
  readonly id: string
  /** The exercise the `ServiceRequest` asks for. */
  readonly code: ExerciseConcept.Type
  /** The canonical url of the training plan definition the `ServiceRequest` follows; see {@link trainingPlanDefinitionUrlOf}. */
  readonly instantiatesCanonical: readonly [string]
}

/**
 * Decodes a `ServiceRequest` into a {@link Type} — fails, naming the field, on
 * no `id`, no single training plan definition url, no exercise `code`, or a
 * `load`, `sets` or `reps` order detail missing, repeated, malformed or out of
 * range.
 */
const ExerciseRequestSchema: Schema.Schema<Type, ServiceRequest.Type> =
  narrowedFrom<ServiceRequest.Type>()(
    narrowFields(Schema.typeSchema(withMandatoryId(ServiceRequest.Schema)), {
      code: Schema.typeSchema(ExerciseConcept.Schema),
      instantiatesCanonical: Schema.Tuple(Schema.String),
      orderDetail: Schema.Array(Schema.typeSchema(CodeableConcept.Schema)).pipe(
        filterArrayWithEveryCheck([
          checkArrayHasOneExerciseParameter(ExerciseParameter.Code.Load),
          checkArrayHasOneExerciseParameter(ExerciseParameter.Code.Sets),
          checkArrayHasOneExerciseParameter(ExerciseParameter.Code.Reps),
        ])
      ),
    }).pipe(Schema.brand('ExerciseRequest'))
  )

/**
 * `ExerciseRequest.make` was asked for an exercise the training plan
 * definition does not run — none of its days has an exercise (definition) for
 * it.
 */
class ExerciseNotInTrainingPlanDefinition extends Data.TaggedError(
  'ExerciseNotInTrainingPlanDefinition'
)<{
  /** The exercise asked for, by id. */
  readonly exerciseId: string
  /** The canonical url of the training plan definition it is not in. */
  readonly trainingPlanDefinitionUrl: string
}> {
  // Data.TaggedError leaves `.message` empty by default; name the exercise so
  // a logged or thrown refusal says what was wrong.
  override get message(): string {
    return `the training plan definition ${this.trainingPlanDefinitionUrl} does not run the exercise ${JSON.stringify(this.exerciseId)}`
  }
}

/** A decoded `ServiceRequest` with every optional slot empty, for an `ExerciseRequest` to be spread onto. */
const emptyServiceRequest: ServiceRequest.Type = Schema.decodeSync(ServiceRequest.Schema)({
  resourceType: 'ServiceRequest',
  status: 'active',
  intent: 'plan',
  subject: {},
})

/**
 * An exercise `ServiceRequest` holding these slots — `active`, intent `plan`,
 * priority `routine`, under the `strength-training` feature `category`, every
 * other slot empty — decoded, so what {@link make} and {@link progress} issue
 * is checked alike.
 */
const decodeServiceRequest = (
  slots: Pick<
    Type,
    'id' | 'subject' | 'code' | 'orderDetail' | 'replaces' | 'instantiatesCanonical' | 'authoredOn'
  >
): Either.Either<Type, ParseResult.ParseError> =>
  Schema.decodeEither(ExerciseRequestSchema, { errors: 'all' })({
    ...emptyServiceRequest,
    ...slots,
    status: 'active',
    intent: 'plan',
    priority: 'routine',
    category: [LiftingFeature.concept],
  })

/**
 * `ExerciseRequest.makeForEachExercise` was given no starting load for
 * exercises the training plan definition runs, listing every one of them.
 */
class ExerciseWithoutStartingLoad extends Data.TaggedError('ExerciseWithoutStartingLoad')<{
  /** The ids of every exercise the training plan definition runs that has no starting load. */
  readonly exerciseIds: Arr.NonEmptyReadonlyArray<string>
  /** The canonical url of the training plan definition. */
  readonly trainingPlanDefinitionUrl: string
}> {
  // Data.TaggedError leaves `.message` empty by default; name the exercises so
  // a logged or thrown refusal says what was wrong.
  override get message(): string {
    return `no starting load for the exercises ${this.exerciseIds.map((id) => JSON.stringify(id)).join(', ')} of the training plan definition ${this.trainingPlanDefinitionUrl}`
  }
}

/**
 * The first `ExerciseRequest` at `trainingPlanDefinitionExercise`, one of
 * `trainingPlanDefinition`'s, at `load`; or a `ParseError` when the load is in
 * another unit than the exercise's rule moves, or under its minimum load.
 */
const makeForTrainingPlanDefinitionExercise = ({
  serviceRequestId,
  subject,
  trainingPlanDefinition,
  trainingPlanDefinitionExercise,
  load,
  authoredOn,
}: {
  readonly serviceRequestId: string
  readonly subject: IdentifierAndReference.ReferenceType
  readonly trainingPlanDefinition: TrainingPlanDefinition.Type
  readonly trainingPlanDefinitionExercise: TrainingPlanDefinition.Exercise.Type
  readonly load: Load.Type
  readonly authoredOn: DateTime.Utc
}): Either.Either<Type, ParseResult.ParseError> =>
  pipe(
    Schema.validateEither(
      TrainingPlanDefinition.ProgressionRule.startingLoadSchema(
        TrainingPlanDefinition.Exercise.progressionRuleOf(trainingPlanDefinitionExercise)
      ),
      { errors: 'all' }
    )(load),
    Either.flatMap((startingLoad) =>
      decodeServiceRequest({
        id: serviceRequestId,
        subject,
        instantiatesCanonical: [trainingPlanDefinition.url],
        code: TrainingPlanDefinition.Exercise.exerciseConceptOf(trainingPlanDefinitionExercise),
        orderDetail: [
          loadExerciseParameterConcept(startingLoad),
          countExerciseParameterConcept({
            code: ExerciseParameter.Code.Sets,
            value: TrainingPlanDefinition.Exercise.setsOf(trainingPlanDefinitionExercise),
          }),
          countExerciseParameterConcept({
            code: ExerciseParameter.Code.Reps,
            value: TrainingPlanDefinition.Exercise.repsOf(trainingPlanDefinitionExercise),
          }),
        ],
        replaces: [],
        authoredOn: DateTime.formatIso(authoredOn),
      })
    )
  )

/**
 * The first `ExerciseRequest` at one exercise of a training plan definition:
 * `active`, intent `plan`, priority `routine`, filed under the
 * `strength-training` feature `category`, the exercise as its `code`, one
 * `orderDetail` per exercise parameter — `load` as a UCUM `valueQuantity`,
 * `sets` and `reps` as a `valueInteger`, each in the concept's
 * `ExerciseParameterValue` extension — instantiating the training plan
 * definition's url, `authoredOn` when it was issued. Its sets and reps are
 * the training plan definition's for the exercise. Made from the id the app
 * minted for the `ServiceRequest`, the lifter it is for as its `subject`, the
 * training plan definition and the exercise in it, the load to start at, and
 * when it was issued.
 *
 * @returns The new `ExerciseRequest`;
 *   {@link ExerciseNotInTrainingPlanDefinition} when the training plan
 *   definition does not run the exercise; or a `ParseError` when the load is
 *   in another unit than the exercise's rule moves, or under the rule's
 *   minimum load
 *
 * @remarks
 * This is how one lifter's starting load is set, and how one is re-made after
 * a training plan definition edit; {@link makeForEachExercise} starts a whole
 * training plan definition. Between workouts, {@link progress} issues the
 * next one.
 */
const make = ({
  exerciseId,
  ...exerciseRequest
}: {
  readonly serviceRequestId: string
  readonly subject: IdentifierAndReference.ReferenceType
  readonly trainingPlanDefinition: TrainingPlanDefinition.Type
  readonly exerciseId: string
  readonly load: Load.Type
  readonly authoredOn: DateTime.Utc
}): Either.Either<Type, ExerciseNotInTrainingPlanDefinition | ParseResult.ParseError> =>
  pipe(
    TrainingPlanDefinition.exerciseOf({
      trainingPlanDefinition: exerciseRequest.trainingPlanDefinition,
      exerciseId,
    }),
    Either.fromOption(
      () =>
        new ExerciseNotInTrainingPlanDefinition({
          exerciseId,
          trainingPlanDefinitionUrl: exerciseRequest.trainingPlanDefinition.url,
        })
    ),
    Either.flatMap((trainingPlanDefinitionExercise) =>
      makeForTrainingPlanDefinitionExercise({ ...exerciseRequest, trainingPlanDefinitionExercise })
    )
  )

/** Starting loads by exercise id, as `StrongLifts5x5.STARTING_LOADS` holds the template's. */
type StartingLoads = EffectRecord.ReadonlyRecord<string, Load.Type>

/**
 * A lifter starting a training plan definition: one `ExerciseRequest` per
 * exercise it runs ({@link TrainingPlanDefinition.exercisesOf}), in that
 * order, each made as {@link make} makes one at its starting load.
 *
 * @param start - The lifter as `subject`; the training plan definition;
 *   `startingLoads`, by exercise id (entries for exercises it does not run are
 *   passed over); `mintServiceRequestId`, the id the app mints for the
 *   `ServiceRequest` at an exercise, called once per exercise — return the
 *   same id for the same exercise on a retry so writing again overwrites
 *   rather than duplicates; and when they were issued
 * @returns The `ExerciseRequest`s; {@link ExerciseWithoutStartingLoad}
 *   listing every exercise with no starting load; or the `ParseError` of the
 *   first exercise whose starting load is in another unit than its rule
 *   moves, or under its minimum load
 *
 * @remarks
 * A form that sets each starting load shows each one's problem as it is
 * entered through `TrainingPlanDefinition.ProgressionRule.startingLoadSchema`.
 */
const makeForEachExercise = ({
  subject,
  trainingPlanDefinition,
  startingLoads,
  mintServiceRequestId,
  authoredOn,
}: {
  readonly subject: IdentifierAndReference.ReferenceType
  readonly trainingPlanDefinition: TrainingPlanDefinition.Type
  readonly startingLoads: StartingLoads
  readonly mintServiceRequestId: (exerciseId: string) => string
  readonly authoredOn: DateTime.Utc
}): Either.Either<readonly Type[], ExerciseWithoutStartingLoad | ParseResult.ParseError> => {
  const [exerciseIdsWithoutStartingLoad, startingTrainingPlanDefinitionExercises] =
    Arr.partitionMap(
      TrainingPlanDefinition.exercisesOf(trainingPlanDefinition),
      (trainingPlanDefinitionExercise) => {
        const exerciseId = TrainingPlanDefinition.Exercise.exerciseIdOf(
          trainingPlanDefinitionExercise
        )
        return Option.match(EffectRecord.get(startingLoads, exerciseId), {
          onNone: () => Either.left(exerciseId),
          onSome: (load) => Either.right({ exerciseId, trainingPlanDefinitionExercise, load }),
        })
      }
    )
  if (Arr.isNonEmptyReadonlyArray(exerciseIdsWithoutStartingLoad))
    return Either.left(
      new ExerciseWithoutStartingLoad({
        exerciseIds: exerciseIdsWithoutStartingLoad,
        trainingPlanDefinitionUrl: trainingPlanDefinition.url,
      })
    )
  return Either.all(
    startingTrainingPlanDefinitionExercises.map(
      ({ exerciseId, trainingPlanDefinitionExercise, load }) =>
        makeForTrainingPlanDefinitionExercise({
          serviceRequestId: mintServiceRequestId(exerciseId),
          subject,
          trainingPlanDefinition,
          trainingPlanDefinitionExercise,
          load,
          authoredOn,
        })
    )
  )
}

/**
 * What changing a lifter's training plan definition writes: every
 * `ExerciseRequest` of the one being left closed, and one per exercise of the
 * one being started.
 */
interface TrainingPlanDefinitionChange {
  /** The `ExerciseRequest`s that were active, each now `revoked`. */
  readonly revokedExerciseRequests: readonly Type[]
  /** The new `ExerciseRequest`s, one per exercise of the training plan definition started. */
  readonly startedExerciseRequests: readonly Type[]
}

/**
 * A lifter leaving their training plan definition for `trainingPlanDefinition`:
 * each of `exerciseRequests` still `active` is closed as `revoked`
 * ({@link close}), and the new training plan definition is started as
 * {@link makeForEachExercise} starts one.
 *
 * @param change - The lifter's current `ExerciseRequest`s (those already
 *   closed are passed over), and the arguments of
 *   {@link makeForEachExercise} for the training plan definition started —
 *   mint ids no earlier `ServiceRequest` has, since the same exercise may run
 *   under both
 * @returns The `ServiceRequest`s to write; or the refusal of
 *   {@link makeForEachExercise}
 *
 * @remarks
 * Restarting the same training plan definition (at new starting loads) is a
 * change to itself.
 */
const changeTrainingPlanDefinition = ({
  exerciseRequests,
  ...start
}: {
  readonly exerciseRequests: readonly Type[]
  readonly subject: IdentifierAndReference.ReferenceType
  readonly trainingPlanDefinition: TrainingPlanDefinition.Type
  readonly startingLoads: StartingLoads
  readonly mintServiceRequestId: (exerciseId: string) => string
  readonly authoredOn: DateTime.Utc
}): Either.Either<
  TrainingPlanDefinitionChange,
  ExerciseWithoutStartingLoad | ParseResult.ParseError
> =>
  Either.map(
    makeForEachExercise(start),
    (startedExerciseRequests): TrainingPlanDefinitionChange => ({
      revokedExerciseRequests: exerciseRequests
        .filter((exerciseRequest) => exerciseRequest.status === 'active')
        .map((exerciseRequest) => close(exerciseRequest, 'revoked')),
      startedExerciseRequests,
    })
  )

/** The exercise the `ServiceRequest` asks for. */
const exerciseOf = (exerciseRequest: Type): ExerciseConcept.Type => exerciseRequest.code

/** The load to lift, from the `load` order detail. */
const loadOf = (exerciseRequest: Type): Load.Type =>
  loadExerciseParameterAmong(exerciseRequest.orderDetail)

/** Sets to perform each workout, from the `sets` order detail; a positive integer. */
const setsOf = (exerciseRequest: Type): number =>
  countExerciseParameterAmong(exerciseRequest.orderDetail, ExerciseParameter.Code.Sets)

/** Reps per set, from the `reps` order detail; a positive integer. */
const repsOf = (exerciseRequest: Type): number =>
  countExerciseParameterAmong(exerciseRequest.orderDetail, ExerciseParameter.Code.Reps)

/** The canonical url of the training plan definition the `ServiceRequest` follows: its one `instantiatesCanonical`. */
const trainingPlanDefinitionUrlOf = (exerciseRequest: Type): string =>
  exerciseRequest.instantiatesCanonical[0]

/** The `ServiceRequest.status`es that close an `ExerciseRequest`. */
type ClosingStatus = Extract<ServiceRequest.Type['status'], 'completed' | 'revoked'>

/**
 * An `ExerciseRequest` closed: `completed` when met, or `revoked` when
 * abandoned — on a deload, and for every active one of a training plan
 * definition being left.
 */
const close = (exerciseRequest: Type, status: ClosingStatus): Type => ({
  ...exerciseRequest,
  status,
})

/** The one `ExerciseRequest` among several at `exerciseId`; `None` when there are none or several. */
const forExercise = (
  exerciseRequests: readonly Type[],
  exerciseId: string
): Option.Option<Type> => {
  const matching = exerciseRequests.filter(
    (exerciseRequest) => ExerciseConcept.idOf(exerciseOf(exerciseRequest)) === exerciseId
  )
  return matching.length === 1 ? Arr.head(matching) : Option.none()
}

/**
 * One attempt at an `ExerciseRequest`'s load: a completed `WorkoutProcedure`
 * and the sets in it logged against that `ExerciseRequest`, earliest first —
 * what {@link isMetBy} judges.
 */
interface Attempt {
  /** The completed workout. */
  readonly workoutProcedure: WorkoutProcedure.Type
  /** The sets of the exercise performed in it, earliest first. */
  readonly exerciseSetObservations: Arr.NonEmptyReadonlyArray<ExerciseSetObservation.Type>
}

/**
 * The attempts at an `ExerciseRequest`: each completed workout that carried it
 * out and has sets logged against it, earliest first by start, with those
 * sets.
 *
 * @param exerciseRequest - The one whose attempts to list
 * @param performed - The lifter's workouts and sets, in any order; workouts
 *   that did not carry it out, sets logged against another one, and workouts
 *   still in progress are passed over
 *
 * @remarks
 * A completed workout with no set logged against it (the lifter skipped the
 * exercise) is no attempt, so it counts neither way.
 */
const attemptsAt = (
  exerciseRequest: Type,
  performed: {
    readonly workoutProcedures: readonly WorkoutProcedure.Type[]
    readonly exerciseSetObservations: readonly ExerciseSetObservation.Type[]
  }
): readonly Attempt[] => {
  const ownExerciseSetObservations = performed.exerciseSetObservations.filter(
    (exerciseSetObservation) =>
      ExerciseSetObservation.serviceRequestIdOf(exerciseSetObservation) === exerciseRequest.id
  )
  return WorkoutProcedure.completedByStart(performed.workoutProcedures)
    .filter((workoutProcedure) =>
      WorkoutProcedure.serviceRequestIdsOf(workoutProcedure).includes(exerciseRequest.id)
    )
    .flatMap((workoutProcedure) =>
      Arr.match(
        ExerciseSetObservation.sortByStart(
          ownExerciseSetObservations.filter(
            (exerciseSetObservation) =>
              ExerciseSetObservation.procedureIdOf(exerciseSetObservation) === workoutProcedure.id
          )
        ),
        {
          onEmpty: () => [],
          onNonEmpty: (exerciseSetObservations): readonly Attempt[] => [
            { workoutProcedure, exerciseSetObservations },
          ],
        }
      )
    )
}

/**
 * Whether an attempt met the `ExerciseRequest`: at least its sets performed,
 * and each of the first that many reaching its reps.
 *
 * @remarks
 * Sets past the ones asked for are extra work and do not count either way.
 */
const isMetBy = (exerciseRequest: Type, attempt: Attempt): boolean =>
  attempt.exerciseSetObservations.length >= setsOf(exerciseRequest) &&
  attempt.exerciseSetObservations
    .slice(0, setsOf(exerciseRequest))
    .every(
      (exerciseSetObservation) =>
        ExerciseSetObservation.repsOf(exerciseSetObservation) >= repsOf(exerciseRequest)
    )

/**
 * What the attempts at an `ExerciseRequest` do to it: close it as met and
 * issue the next at the incremented load, keep it open, or close it as
 * abandoned and issue the next at the deloaded load.
 */
type Decision = 'increment' | 'hold' | 'deload'

/** The {@link Decision} {@link progress} made, and the `ServiceRequest`s it writes. */
interface Progress {
  /** Which way the load moved. */
  readonly decision: Decision
  /**
   * The current `ExerciseRequest`: `completed` after an increment, `revoked`
   * after a deload, unchanged on a hold.
   */
  readonly current: Type
  /**
   * The one issued in its place — at the new load, everything else
   * unchanged, `replaces` naming the current one; `None` on a hold.
   */
  readonly next: Option.Option<Type>
}

/**
 * Tolerance for floating-point error when rounding a deloaded load down to a
 * step multiple, so `150 × 0.9` computed as `134.99999…` still lands on 135.
 */
const ROUNDING_TOLERANCE = 1e-9

/**
 * How many of the most recent attempts at an `ExerciseRequest` failed in a
 * row — the count a deload waits on ("failure 2 of 3").
 *
 * @param exerciseRequest - The one the attempts were at
 * @param attempts - Its attempts, earliest first, as {@link attemptsAt} lists them
 * @returns The length of the trailing run of attempts that did not meet it
 *
 * @remarks
 * Every attempt counted is at its load: a new load is a new `ExerciseRequest`,
 * so no attempt at an earlier load can count against this one.
 */
const consecutiveFailures = (exerciseRequest: Type, attempts: readonly Attempt[]): number =>
  pipe(
    Arr.reverse(attempts),
    Arr.takeWhile((attempt) => !isMetBy(exerciseRequest, attempt))
  ).length

/** `load` rounded down to a multiple of `step`, within {@link ROUNDING_TOLERANCE}. */
const roundDownToStep = ({
  load,
  step,
}: {
  readonly load: number
  readonly step: number
}): number => Math.floor(load / step + ROUNDING_TOLERANCE) * step

/**
 * The load a deload lands on: cut by the deload fraction, rounded down to a
 * multiple of the load step, and raised back to the minimum load if it fell
 * below it.
 *
 * @remarks
 * Rounding down, not to nearest, so a deload never lands above the fraction it
 * promises. The rounded load is also capped at the current load rounded down
 * with no tolerance, so the tolerance can never lift a load that sits a hair
 * under a step multiple.
 */
const deloadedLoad = (
  progressionRule: TrainingPlanDefinition.ProgressionRule.Type,
  load: number
): number =>
  Math.max(
    TrainingPlanDefinition.ProgressionRule.minimumLoadOf(progressionRule),
    Math.min(
      roundDownToStep({
        load: load * (1 - TrainingPlanDefinition.ProgressionRule.deloadFractionOf(progressionRule)),
        step: TrainingPlanDefinition.ProgressionRule.loadStepOf(progressionRule),
      }),
      Math.floor(load / TrainingPlanDefinition.ProgressionRule.loadStepOf(progressionRule)) *
        TrainingPlanDefinition.ProgressionRule.loadStepOf(progressionRule)
    )
  )

/** The status each moving decision closes the current `ExerciseRequest` with. */
const CLOSING_STATUS_OF: { readonly [Moved in Exclude<Decision, 'hold'>]: ClosingStatus } = {
  increment: 'completed',
  deload: 'revoked',
}

/**
 * One progression step for one `ExerciseRequest`: decide from its attempts
 * whether its load goes up, stays, or deloads, and write the
 * `ServiceRequest`s that apply the decision.
 *
 * @param step - The current `ExerciseRequest`; the training plan definition's
 *   rule for its exercise; the lifter's workouts and sets, in any order (see
 *   {@link attemptsAt}); the id the app minted for the next `ServiceRequest`,
 *   when one is issued; and when the step was taken, its `authoredOn`
 * @returns The decision, the current one closed as it says, and the next
 *   one; or a `ParseError` when the current load is in a unit the rule does
 *   not move
 *
 * @remarks
 * The rule, over the attempts {@link attemptsAt} lists:
 *
 * - **increment** — the most recent attempt met it (see
 *   {@link isMetBy}): it is closed as `completed`, and the next one is the
 *   rule's increment heavier.
 * - **deload** — otherwise, when {@link consecutiveFailures} has reached the
 *   rule's failures before a deload and the deloaded load (cut by the deload
 *   fraction, rounded down to a multiple of the load step, never below the
 *   minimum load) is lower than the current one: it is closed as `revoked`,
 *   and the next one is at the deloaded load.
 * - **hold** — otherwise: no attempt yet, too few failures, or a deload that
 *   would not lower a load already at its floor. Nothing is written.
 *
 * A workout still in progress is never judged. The next `ExerciseRequest`
 * has no attempts yet, so running the step on it holds until its own workouts say
 * otherwise.
 */
const progress = (step: {
  readonly exerciseRequest: Type
  readonly progressionRule: TrainingPlanDefinition.ProgressionRule.Type
  readonly workoutProcedures: readonly WorkoutProcedure.Type[]
  readonly exerciseSetObservations: readonly ExerciseSetObservation.Type[]
  readonly nextServiceRequestId: string
  readonly authoredOn: DateTime.Utc
}): Either.Either<Progress, ParseResult.ParseError> => {
  const { exerciseRequest, progressionRule } = step
  return pipe(
    Schema.validateEither(
      TrainingPlanDefinition.ProgressionRule.movableLoadSchema(progressionRule)
    )(loadOf(exerciseRequest)),
    Either.flatMap((load) => {
      const attempts = attemptsAt(exerciseRequest, step)
      const value = Load.valueOf(load)
      const moved = pipe(
        Arr.last(attempts),
        Option.filter((latest) => isMetBy(exerciseRequest, latest)),
        Option.map(() => ({
          decision: 'increment' as const,
          value: value + TrainingPlanDefinition.ProgressionRule.incrementOf(progressionRule),
        })),
        Option.orElse(() =>
          pipe(
            Option.some(deloadedLoad(progressionRule, value)),
            Option.filter(
              (deloaded) =>
                deloaded < value &&
                consecutiveFailures(exerciseRequest, attempts) >=
                  TrainingPlanDefinition.ProgressionRule.failuresBeforeDeloadOf(progressionRule)
            ),
            Option.map((deloaded) => ({ decision: 'deload' as const, value: deloaded }))
          )
        )
      )
      return Option.match(moved, {
        onNone: (): Either.Either<Progress, ParseResult.ParseError> =>
          Either.right({ decision: 'hold', current: exerciseRequest, next: Option.none() }),
        onSome: ({ decision, value: nextValue }) =>
          pipe(
            Load.withValue(load, nextValue),
            Either.flatMap((nextLoad) =>
              decodeServiceRequest({
                id: step.nextServiceRequestId,
                subject: exerciseRequest.subject,
                instantiatesCanonical: exerciseRequest.instantiatesCanonical,
                code: exerciseOf(exerciseRequest),
                orderDetail: exerciseRequest.orderDetail.map((detail) =>
                  isExerciseParameterConcept(ExerciseParameter.Code.Load)(detail)
                    ? loadExerciseParameterConcept(nextLoad)
                    : detail
                ),
                replaces: [
                  IdentifierAndReference.referenceTo({
                    resourceType: 'ServiceRequest',
                    id: exerciseRequest.id,
                  }),
                ],
                authoredOn: DateTime.formatIso(step.authoredOn),
              })
            ),
            Either.map((next): Progress => ({
              decision,
              current: close(exerciseRequest, CLOSING_STATUS_OF[decision]),
              next: Option.some(next),
            }))
          ),
      })
    })
  )
}

export {
  attemptsAt,
  changeTrainingPlanDefinition,
  close,
  consecutiveFailures,
  ExerciseRequestSchema as Schema,
  ExerciseNotInTrainingPlanDefinition,
  ExerciseWithoutStartingLoad,
  exerciseOf,
  forExercise,
  isMetBy,
  loadOf,
  make,
  makeForEachExercise,
  trainingPlanDefinitionUrlOf,
  progress,
  repsOf,
  setsOf,
}
export type {
  Attempt,
  ClosingStatus,
  Decision,
  Progress,
  StartingLoads,
  TrainingPlanDefinitionChange,
  Type,
}
