import {
  Array as Arr,
  type Brand,
  Data,
  DateTime,
  Either,
  Option,
  type ParseResult,
  pipe,
  Schema,
} from 'effect'
import { IdentifierAndReference, narrowFields, withMandatoryId } from 'fhir-r4/data-types'
import { ServiceRequest } from 'fhir-r4/resources'

import * as ExerciseSetObservation from '../exercise-set-observation/exercise-set-observation.ts'
import * as ExerciseConcept from '../exercise/exercise-concept.ts'
import { narrowedFrom } from '../internal/narrowed-from.ts'
import * as LiftingFeature from '../lifting-feature/lifting-feature.ts'
import * as LiftingMeasure from '../lifting-measure/lifting-measure.ts'
import {
  countAmong,
  countConcept,
  loadAmong,
  loadConcept,
  measureIssues,
  measures,
} from '../lifting-measure/measure-concept.ts'
import * as Load from '../load/load.ts'
import * as Plan from '../plan/plan.ts'
import * as PlannedExercise from '../plan/planned-exercise.ts'
import * as ProgressionRule from '../plan/progression-rule.ts'
import * as WorkoutProcedure from '../workout-procedure/workout-procedure.ts'

/**
 * What a lifter is to do at one exercise until it moves, as FHIR orders it: a
 * `ServiceRequest` whose service is an exercise, narrowed to an `id`, an
 * {@link ExerciseConcept.Type} as its `code`, exactly one
 * `instantiatesCanonical` — the url of the plan it follows — and exactly one
 * `load`, one `sets` and one `reps` `orderDetail`, each carrying its value in
 * range: lift the load for sets × reps.
 *
 * @remarks
 * Each one is one load: a met workout closes it (`completed`) and issues the
 * next one heavier, a deload closes it (`revoked`) and issues the next one
 * lighter, and a change of program revokes them all. It carries no rule:
 * how its load moves is the plan's, on the `PlannedExercise` for the same
 * exercise. Its `status` is not narrowed — the app searches `status=active`.
 * Other order details ride along untouched.
 */
interface Type
  extends
    Omit<ServiceRequest.Type, 'id' | 'code' | 'instantiatesCanonical'>,
    Brand.Brand<'ExerciseRequest'> {
  /** The id the `ServiceRequest` is stored under. */
  readonly id: string
  /** The exercise the `ServiceRequest` asks for. */
  readonly code: ExerciseConcept.Type
  /** The canonical url of the plan the `ServiceRequest` follows; see {@link planUrlOf}. */
  readonly instantiatesCanonical: readonly [string]
}

/**
 * Decodes a `ServiceRequest` into a {@link Type} — fails, naming the field, on
 * no `id`, no single plan url, no exercise `code`, or a `load`, `sets` or
 * `reps` order detail missing, repeated, malformed or out of range.
 */
const ExerciseRequestSchema: Schema.Schema<Type, ServiceRequest.Type> =
  narrowedFrom<ServiceRequest.Type>()(
    narrowFields(Schema.typeSchema(withMandatoryId(ServiceRequest.Schema)), {
      code: Schema.typeSchema(ExerciseConcept.Schema),
      instantiatesCanonical: Schema.Tuple(Schema.String),
    }).pipe(
      Schema.filter((serviceRequest) =>
        [LiftingMeasure.Code.Load, LiftingMeasure.Code.Sets, LiftingMeasure.Code.Reps].flatMap(
          (measure) =>
            measureIssues({ concepts: serviceRequest.orderDetail, measure, path: ['orderDetail'] })
        )
      ),
      Schema.brand('ExerciseRequest')
    )
  )

/** `ExerciseRequest.make` was asked for an exercise the plan does not run. */
class ExerciseUnplanned extends Data.TaggedError('ExerciseUnplanned')<{
  /** The exercise asked for, by id. */
  readonly exerciseId: string
}> {
  // Data.TaggedError leaves `.message` empty by default; name the exercise so
  // a logged or thrown refusal says what was wrong.
  override get message(): string {
    return `the plan does not run the exercise ${JSON.stringify(this.exerciseId)}`
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
 * The first `ExerciseRequest` at one exercise of a plan: `active`, intent
 * `plan`, priority `routine`, filed under the `strength-training` feature
 * `category`, the exercise as its `code`, one `orderDetail` per measure —
 * `load` as a UCUM `valueQuantity`, `sets` and `reps` as a `valueInteger`,
 * each in the concept's `LiftingMeasureValue` extension — instantiating the
 * plan's url, `authoredOn` when it was issued. Its sets and reps are the
 * plan's for the exercise. Made from the id the app minted for the
 * `ServiceRequest`, the lifter it is for as its `subject`, the plan and the
 * exercise in it, the load to start at, and when it was issued.
 *
 * @returns The new `ExerciseRequest`; {@link ExerciseUnplanned} when the plan does
 *   not run the exercise; or a `ParseError` when the load is in another unit
 *   than the exercise's rule moves, or under the rule's minimum load
 *
 * @remarks
 * This is how a lifter's starting load is set, and how one is re-made after a
 * plan edit. Between workouts, {@link progress} issues the next one.
 */
const make = ({
  serviceRequestId,
  subject,
  plan,
  exerciseId,
  load,
  authoredOn,
}: {
  readonly serviceRequestId: string
  readonly subject: IdentifierAndReference.ReferenceType
  readonly plan: Plan.Type
  readonly exerciseId: string
  readonly load: Load.Type
  readonly authoredOn: DateTime.Utc
}): Either.Either<Type, ExerciseUnplanned | ParseResult.ParseError> =>
  pipe(
    Plan.plannedExerciseOf(plan, exerciseId),
    Either.fromOption(() => new ExerciseUnplanned({ exerciseId })),
    Either.flatMap((planned) =>
      pipe(
        Schema.validateEither(
          ProgressionRule.startingLoadSchema(PlannedExercise.progressionRuleOf(planned)),
          { errors: 'all' }
        )(load),
        Either.flatMap((startingLoad) =>
          decodeServiceRequest({
            id: serviceRequestId,
            subject,
            instantiatesCanonical: [plan.url],
            code: PlannedExercise.exerciseOf(planned),
            orderDetail: [
              loadConcept(startingLoad),
              countConcept({
                measure: LiftingMeasure.Code.Sets,
                value: PlannedExercise.setsOf(planned),
              }),
              countConcept({
                measure: LiftingMeasure.Code.Reps,
                value: PlannedExercise.repsOf(planned),
              }),
            ],
            replaces: [],
            authoredOn: DateTime.formatIso(authoredOn),
          })
        )
      )
    )
  )

/** The exercise the `ServiceRequest` asks for. */
const exerciseOf = (exerciseRequest: Type): ExerciseConcept.Type => exerciseRequest.code

/** The load to lift, from the `load` order detail. */
const loadOf = (exerciseRequest: Type): Load.Type => loadAmong(exerciseRequest.orderDetail)

/** Sets to perform each workout, from the `sets` order detail; a positive integer. */
const setsOf = (exerciseRequest: Type): number =>
  countAmong(exerciseRequest.orderDetail, LiftingMeasure.Code.Sets)

/** Reps per set, from the `reps` order detail; a positive integer. */
const repsOf = (exerciseRequest: Type): number =>
  countAmong(exerciseRequest.orderDetail, LiftingMeasure.Code.Reps)

/** The canonical url of the plan the `ServiceRequest` follows: its one `instantiatesCanonical`. */
const planUrlOf = (exerciseRequest: Type): string => exerciseRequest.instantiatesCanonical[0]

/** The `ServiceRequest.status`es that close an `ExerciseRequest`. */
type ClosingStatus = Extract<ServiceRequest.Type['status'], 'completed' | 'revoked'>

/**
 * An `ExerciseRequest` closed: `completed` when met, or `revoked` when
 * abandoned — on a deload, and for every active one of a plan being left.
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
const deloadedLoad = (rule: ProgressionRule.Type, load: number): number =>
  Math.max(
    ProgressionRule.minimumLoadOf(rule),
    Math.min(
      roundDownToStep({
        load: load * (1 - ProgressionRule.deloadFractionOf(rule)),
        step: ProgressionRule.loadStepOf(rule),
      }),
      Math.floor(load / ProgressionRule.loadStepOf(rule)) * ProgressionRule.loadStepOf(rule)
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
 * @param step - The current `ExerciseRequest`; the plan's rule for its
 *   exercise; the lifter's workouts and sets, in any order (see
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
  readonly progressionRule: ProgressionRule.Type
  readonly workoutProcedures: readonly WorkoutProcedure.Type[]
  readonly exerciseSetObservations: readonly ExerciseSetObservation.Type[]
  readonly nextServiceRequestId: string
  readonly authoredOn: DateTime.Utc
}): Either.Either<Progress, ParseResult.ParseError> => {
  const { exerciseRequest, progressionRule } = step
  return pipe(
    Schema.validateEither(ProgressionRule.movableLoadSchema(progressionRule))(
      loadOf(exerciseRequest)
    ),
    Either.flatMap((load) => {
      const attempts = attemptsAt(exerciseRequest, step)
      const value = Load.valueOf(load)
      const moved = pipe(
        Arr.last(attempts),
        Option.filter((latest) => isMetBy(exerciseRequest, latest)),
        Option.map(() => ({
          decision: 'increment' as const,
          value: value + ProgressionRule.incrementOf(progressionRule),
        })),
        Option.orElse(() =>
          pipe(
            Option.some(deloadedLoad(progressionRule, value)),
            Option.filter(
              (deloaded) =>
                deloaded < value &&
                consecutiveFailures(exerciseRequest, attempts) >=
                  ProgressionRule.failuresBeforeDeloadOf(progressionRule)
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
                  measures(LiftingMeasure.Code.Load)(detail) ? loadConcept(nextLoad) : detail
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
  close,
  consecutiveFailures,
  ExerciseRequestSchema as Schema,
  ExerciseUnplanned,
  exerciseOf,
  forExercise,
  isMetBy,
  loadOf,
  make,
  planUrlOf,
  progress,
  repsOf,
  setsOf,
}
export type { Attempt, ClosingStatus, Decision, Progress, Type }
