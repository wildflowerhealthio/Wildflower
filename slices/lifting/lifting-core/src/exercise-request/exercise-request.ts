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
import {
  type CodeableConcept,
  IdentifierAndReference,
  narrowFields,
  withMandatoryId,
} from 'fhir-r4/data-types'
import { ServiceRequest } from 'fhir-r4/resources'

import * as ExerciseSetObservation from '../exercise-set-observation/exercise-set-observation.ts'
import * as Session from '../exercise-set-observation/session.ts'
import * as ExerciseConcept from '../exercise/exercise-concept.ts'
import { narrowedFrom } from '../internal/narrowed-from.ts'
import {
  countAmong,
  countConcept,
  LiftingMeasureCode,
  loadAmong,
  loadConcept,
  measureIssues,
  measures,
} from '../lifting-measure/lifting-measure.ts'
import * as Load from '../load/load.ts'
import * as Plan from '../plan/plan.ts'
import * as PlannedExercise from '../plan/planned-exercise.ts'
import * as ProgressionRule from '../plan/progression-rule.ts'
import { liftingFeatureConcept } from '../terminology.ts'

/**
 * What a lifter is to do at one exercise until it moves, as FHIR orders it: a
 * `ServiceRequest` whose service is an exercise, narrowed to an `id`, an
 * {@link ExerciseConcept.Type} as its `code`, exactly one
 * `instantiatesCanonical` — the url of the plan it follows — and exactly one
 * `load`, one `sets` and one `reps` `orderDetail`, each carrying its value in
 * range: lift the load for sets × reps.
 *
 * @remarks
 * One `ExerciseRequest` is one load: a met session closes it (`completed`) and
 * issues the next one heavier, a deload closes it (`revoked`) and issues the
 * next one lighter, a change of program revokes them all. It carries no rule:
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
        [LiftingMeasureCode.Load, LiftingMeasureCode.Sets, LiftingMeasureCode.Reps].flatMap(
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
const decodeServiceRequest = (slots: {
  readonly id: string
  readonly subject: IdentifierAndReference.ReferenceType
  readonly instantiatesCanonical: string
  readonly code: ExerciseConcept.Type
  readonly orderDetail: readonly CodeableConcept.Type[]
  readonly replaces: readonly IdentifierAndReference.ReferenceType[]
  readonly authoredOn: DateTime.Utc
}): Either.Either<Type, ParseResult.ParseError> =>
  Schema.decodeEither(ExerciseRequestSchema, { errors: 'all' })({
    ...emptyServiceRequest,
    ...slots,
    status: 'active',
    intent: 'plan',
    priority: 'routine',
    category: [liftingFeatureConcept],
    instantiatesCanonical: [slots.instantiatesCanonical],
    authoredOn: DateTime.formatIso(slots.authoredOn),
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
 * @returns The `ExerciseRequest`; {@link ExerciseUnplanned} when the plan does
 *   not run the exercise; or a `ParseError` when the load is in another unit
 *   than the exercise's rule moves, or under the rule's minimum load
 *
 * @remarks
 * This is how a lifter's starting load is set, and how an `ExerciseRequest` is re-made
 * after a plan edit. Between sessions, {@link progress} issues the next one.
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
            instantiatesCanonical: plan.url,
            code: PlannedExercise.exerciseOf(planned),
            orderDetail: [
              loadConcept(startingLoad),
              countConcept({
                measure: LiftingMeasureCode.Sets,
                value: PlannedExercise.setsOf(planned),
              }),
              countConcept({
                measure: LiftingMeasureCode.Reps,
                value: PlannedExercise.repsOf(planned),
              }),
            ],
            replaces: [],
            authoredOn,
          })
        )
      )
    )
  )

/** The exercise the `ServiceRequest` asks for. */
const exerciseOf = (exerciseRequest: Type): ExerciseConcept.Type => exerciseRequest.code

/** The load to lift, from the `load` order detail. */
const loadOf = (exerciseRequest: Type): Load.Type => loadAmong(exerciseRequest.orderDetail)

/** Sets to perform each session, from the `sets` order detail; a positive integer. */
const setsOf = (exerciseRequest: Type): number =>
  countAmong(exerciseRequest.orderDetail, LiftingMeasureCode.Sets)

/** Reps per set, from the `reps` order detail; a positive integer. */
const repsOf = (exerciseRequest: Type): number =>
  countAmong(exerciseRequest.orderDetail, LiftingMeasureCode.Reps)

/** The canonical url of the plan the `ServiceRequest` follows: its one `instantiatesCanonical`. */
const planUrlOf = (exerciseRequest: Type): string => exerciseRequest.instantiatesCanonical[0]

/** The `ServiceRequest.status`es that close an `ExerciseRequest`. */
type ClosingStatus = Extract<ServiceRequest.Type['status'], 'completed' | 'revoked'>

/**
 * The `ExerciseRequest` closed: `completed` when met, `revoked` when abandoned
 * — on a deload, or for every `active` `ExerciseRequest` of a plan being left.
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
 * Whether a session met the `ExerciseRequest`: at least its sets performed, and each of
 * the first that many reaching its reps.
 *
 * @remarks
 * Sets past the `ExerciseRequest`'s are extra work and do not count either way.
 */
const isMetBy = (exerciseRequest: Type, session: Session.Type): boolean =>
  session.setObservations.length >= setsOf(exerciseRequest) &&
  session.setObservations
    .slice(0, setsOf(exerciseRequest))
    .every(
      (setObservation) => ExerciseSetObservation.repsOf(setObservation) >= repsOf(exerciseRequest)
    )

/**
 * What an `ExerciseRequest`'s sessions do to it: close it as met and issue the next at
 * the incremented load, keep it open, or close it as abandoned and issue the
 * next at the deloaded load.
 */
type Decision = 'increment' | 'hold' | 'deload'

/** The {@link Decision} {@link progress} made, and the `ServiceRequest`s it writes. */
interface Progress {
  /** Which way the load moved. */
  readonly decision: Decision
  /**
   * The current `ExerciseRequest`: `completed` after an increment, `revoked` after a
   * deload, unchanged on a hold.
   */
  readonly current: Type
  /**
   * The `ExerciseRequest` issued in place of the current one — at the new load,
   * everything else unchanged, `replaces` the current one; `None` on a hold.
   */
  readonly next: Option.Option<Type>
}

/**
 * Tolerance for floating-point error when rounding a deloaded load down to a
 * step multiple, so `150 × 0.9` computed as `134.99999…` still lands on 135.
 */
const ROUNDING_TOLERANCE = 1e-9

/**
 * How many of an `ExerciseRequest`'s most recent sessions in a row failed — the count a
 * deload waits on ("failure 2 of 3").
 *
 * @param exerciseRequest - The `ExerciseRequest` the sessions were at
 * @param sessions - Its sessions, earliest first, as `Session.groupByDate` groups them
 * @returns The length of the trailing run of sessions that did not meet the `ExerciseRequest`
 *
 * @remarks
 * Every session here is at the `ExerciseRequest`'s load — an `ExerciseRequest` is one load, and a
 * load change issues a new one — so no session before the current load can
 * count against it.
 */
const consecutiveFailures = (exerciseRequest: Type, sessions: readonly Session.Type[]): number =>
  pipe(
    Arr.reverse(sessions),
    Arr.takeWhile((session) => !isMetBy(exerciseRequest, session))
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
 * One progression step for one `ExerciseRequest`: decide from the sets logged
 * against it whether its load goes up, stays, or deloads, and write the
 * `ServiceRequest`s that apply the decision.
 *
 * @param step - The current `ExerciseRequest`; the plan's rule for its exercise; every
 *   set logged against it, in any order; the lifter's zone, which
 *   groups the sets into sessions; the id the app minted for the next
 *   `ServiceRequest`, when one is issued; and when the step was taken, the next
 *   `ServiceRequest`'s `authoredOn`
 * @returns The decision, the current `ExerciseRequest` closed as it says, and the next
 *   one; or a `ParseError` when the current one's load is in a unit the rule
 *   does not move
 *
 * @remarks
 * The rule, over the sets grouped by `Session.groupByDate`:
 *
 * - **increment** — the most recent session met the `ExerciseRequest` (see
 *   {@link isMetBy}): the current one is `completed`, and the next is the
 *   rule's increment heavier.
 * - **deload** — otherwise, when {@link consecutiveFailures} has reached the
 *   rule's failures before a deload and the deloaded load (cut by the deload
 *   fraction, rounded down to a multiple of the load step, never below the
 *   minimum load) is lower than the current one: the current `ExerciseRequest` is
 *   `revoked`, and the next is at the deloaded load.
 * - **hold** — otherwise: no sets yet, too few failures, or a deload that
 *   would not lower a load already at its floor. Nothing is written.
 *
 * The next `ExerciseRequest` starts with no sets, so running the step on it holds until
 * its own sessions say otherwise.
 */
const progress = (step: {
  readonly exerciseRequest: Type
  readonly progressionRule: ProgressionRule.Type
  readonly setObservations: readonly ExerciseSetObservation.Type[]
  readonly zone: DateTime.TimeZone
  readonly nextServiceRequestId: string
  readonly authoredOn: DateTime.Utc
}): Either.Either<Progress, ParseResult.ParseError> => {
  const { exerciseRequest, progressionRule } = step
  return pipe(
    Schema.validateEither(ProgressionRule.movableLoadSchema(progressionRule))(
      loadOf(exerciseRequest)
    ),
    Either.flatMap((load) => {
      const sessions = Session.groupByDate(step.setObservations, step.zone)
      const value = Load.valueOf(load)
      const moved = pipe(
        Arr.last(sessions),
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
                consecutiveFailures(exerciseRequest, sessions) >=
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
                instantiatesCanonical: planUrlOf(exerciseRequest),
                code: exerciseOf(exerciseRequest),
                orderDetail: exerciseRequest.orderDetail.map((detail) =>
                  measures(LiftingMeasureCode.Load)(detail) ? loadConcept(nextLoad) : detail
                ),
                replaces: [
                  IdentifierAndReference.referenceTo({
                    resourceType: 'ServiceRequest',
                    id: exerciseRequest.id,
                  }),
                ],
                authoredOn: step.authoredOn,
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
export type { ClosingStatus, Decision, Progress, Type }
