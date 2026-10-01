import {
  Array as Arr,
  type Brand,
  Data,
  DateTime,
  Either,
  Option,
  Order,
  type ParseResult,
  pipe,
  Schema,
} from 'effect'
import {
  CodeableConcept,
  Coding,
  IdentifierAndReference,
  narrowFields,
  Period,
  WildflowerCodeSystem,
  withMandatoryId,
} from 'fhir-r4/data-types'
import { Procedure } from 'fhir-r4/resources'

// Type-only: a workout is made from its plan and the `ExerciseRequest`s it
// carries out, but both modules read workouts at runtime, so importing them
// back would be a cycle.
import type * as ExerciseRequest from '../exercise-request/exercise-request.ts'
import { guaranteed, onlyOneIssues } from '../internal/issues.ts'
import { narrowedFrom } from '../internal/narrowed-from.ts'
import { NonBlankString } from '../internal/non-blank-string.ts'
import * as LiftingFeature from '../lifting-feature/lifting-feature.ts'
import type * as Plan from '../plan/plan.ts'
import * as Workout from '../plan/workout.ts'

/** The statuses of a workout this package reasons about: under way, or done. */
const StatusSchema = Schema.Literal('in-progress', 'completed').annotations({
  message: () => ({
    message:
      'expected an in-progress or completed workout; a workout in any other status (stopped, not done, entered in error) is not one progression reasons about',
    override: true,
  }),
})

/**
 * What the one coding of a workout's `code` must carry: its label as a
 * non-blank `code`.
 */
const WorkoutCodingSchema = Schema.Struct({ code: NonBlankString })

/** A workout's `code`: exactly one coding in `WildflowerCodeSystem.Workout`, its label. */
const WorkoutCodeSchema = Schema.typeSchema(CodeableConcept.Schema).pipe(
  Schema.filter((concept) =>
    onlyOneIssues({
      items: concept.coding,
      selected: Coding.isInSystem(WildflowerCodeSystem.Workout),
      schema: WorkoutCodingSchema,
      path: ['coding'],
      expected: `coding in ${WildflowerCodeSystem.Workout}`,
    })
  )
)

/** A decoded `Period` narrowed to a `start`, and an `end` at or after it when there is one. */
const WorkoutPeriodSchema = narrowFields(Schema.typeSchema(Period.Schema), {
  start: Schema.DateTimeUtcFromSelf,
}).pipe(
  Schema.filter(
    (period) => period.end === null || DateTime.greaterThanOrEqualTo(period.end, period.start),
    { message: () => 'expected the end at or after the start' }
  )
)

/** A `basedOn` reference to a `ServiceRequest`. */
const ServiceRequestReferenceSchema = Schema.typeSchema(
  IdentifierAndReference.ReferenceSchema
).pipe(
  Schema.filter(
    (reference) =>
      Option.isSome(IdentifierAndReference.referencedIdOf(reference, 'ServiceRequest')),
    { message: () => 'expected a reference to a ServiceRequest' }
  )
)

/**
 * One workout of a strength-training plan as the lifter performs it, as FHIR
 * records it: a `Procedure` narrowed to an `id`, a status of `in-progress` or
 * `completed`, the workout as its `code` — its label in
 * `WildflowerCodeSystem.Workout` — the plan's url as its one
 * `instantiatesCanonical`, a `performedPeriod` with a `start` (and an `end`
 * exactly when it is completed), and at least one `basedOn`, each a
 * `ServiceRequest`: the `ExerciseRequest`s it carries out.
 *
 * @remarks
 * The sets performed in it are `ExerciseSetObservation`s whose `partOf` names
 * it. A workout in another status (`stopped`, `not-done`, `entered-in-error`,
 * …) does not decode.
 */
interface Type
  extends
    Omit<
      Procedure.Type,
      'id' | 'status' | 'code' | 'instantiatesCanonical' | 'performedPeriod' | 'basedOn'
    >,
    Brand.Brand<'WorkoutProcedure'> {
  /** The id the `Procedure` is stored under. */
  readonly id: string
  /** Under way, or done. */
  readonly status: typeof StatusSchema.Type
  /** The workout of the plan, by its label; see {@link workoutLabelOf}. */
  readonly code: CodeableConcept.Type
  /** The canonical url of the plan the workout belongs to; see {@link planUrlOf}. */
  readonly instantiatesCanonical: readonly [string]
  /** When the workout started, and when it ended once it is completed. */
  readonly performedPeriod: typeof WorkoutPeriodSchema.Type
  /** The `ServiceRequest`s it carries out; see {@link serviceRequestIdsOf}. */
  readonly basedOn: Arr.NonEmptyReadonlyArray<IdentifierAndReference.ReferenceType>
}

/**
 * Decodes a `Procedure` into a {@link Type} — fails, naming the field, on no
 * `id`, a status other than `in-progress` or `completed`, no single workout
 * coding, no single plan url, no start, an end on an in-progress workout or
 * none on a completed one, or no `basedOn` `ServiceRequest`.
 */
const WorkoutProcedureSchema: Schema.Schema<Type, Procedure.Type> = narrowedFrom<Procedure.Type>()(
  narrowFields(Schema.typeSchema(withMandatoryId(Procedure.Schema)), {
    status: StatusSchema,
    code: WorkoutCodeSchema,
    instantiatesCanonical: Schema.Tuple(Schema.String),
    performedPeriod: WorkoutPeriodSchema,
    basedOn: Schema.NonEmptyArray(ServiceRequestReferenceSchema),
  }).pipe(
    Schema.filter(
      (procedure) =>
        (procedure.status === 'completed') === (procedure.performedPeriod.end !== null) || {
          path: ['performedPeriod', 'end'],
          message:
            procedure.status === 'completed'
              ? 'expected a completed workout to have ended'
              : 'expected an in-progress workout not to have ended',
        }
    ),
    Schema.brand('WorkoutProcedure')
  )
)

/**
 * `WorkoutProcedure.make` was asked for a workout the plan does not cycle
 * through — no workout of the plan has its label.
 *
 * @remarks
 * A tagged error rather than a schema refinement: it relates the workout to a
 * plan the `Procedure` names only by url, which no single value's schema can
 * see.
 */
class WorkoutNotInPlan extends Data.TaggedError('WorkoutNotInPlan')<{
  /** The label of the workout asked for. */
  readonly workoutLabel: string
  /** The canonical url of the plan it is not in. */
  readonly planUrl: string
}> {
  // Data.TaggedError leaves `.message` empty by default; name the workout so
  // a logged or thrown refusal says what was wrong.
  override get message(): string {
    return `the plan ${this.planUrl} has no workout labelled ${JSON.stringify(this.workoutLabel)}`
  }
}

/**
 * `WorkoutProcedure.make` was asked to carry out `ExerciseRequest`s that
 * follow another plan — their `instantiatesCanonical` is not the plan's url —
 * listing every one of them.
 *
 * @remarks
 * A tagged error rather than a schema refinement, for the same reason as
 * {@link WorkoutNotInPlan}: it relates two resources.
 */
class ExerciseRequestNotOfPlan extends Data.TaggedError('ExerciseRequestNotOfPlan')<{
  /** The ids of every `ServiceRequest` asked for that follows another plan. */
  readonly serviceRequestIds: Arr.NonEmptyReadonlyArray<string>
  /** The canonical url of the plan it does not follow. */
  readonly planUrl: string
}> {
  // Data.TaggedError leaves `.message` empty by default; name the
  // `ServiceRequest`s so a logged or thrown refusal says what was wrong.
  override get message(): string {
    return `the ServiceRequests ${this.serviceRequestIds.map((id) => JSON.stringify(id)).join(', ')} do not follow the plan ${this.planUrl}`
  }
}

/** A decoded `Procedure` with every optional slot empty, for a workout to be spread onto. */
const emptyProcedure: Procedure.Type = Schema.decodeSync(Procedure.Schema)({
  resourceType: 'Procedure',
  status: 'in-progress',
  subject: {},
})

/**
 * A workout of `plan` the lifter has started: `in-progress`, filed under the
 * `strength-training` feature `category`, the workout's label as its `code`,
 * the plan's url as its `instantiatesCanonical`, `basedOn` each of
 * `exerciseRequests`, and `performedPeriod` starting at `start`.
 *
 * @returns The workout, stored under `procedureId` (the app mints it);
 *   {@link WorkoutNotInPlan} when `workout` is not one of `plan`'s;
 *   {@link ExerciseRequestNotOfPlan} listing every one of `exerciseRequests`
 *   that follows another plan; or a `ParseError` when it carries out no
 *   `ExerciseRequest`
 */
const make = ({
  procedureId,
  subject,
  plan,
  workout,
  exerciseRequests,
  start,
}: {
  readonly procedureId: string
  readonly subject: IdentifierAndReference.ReferenceType
  readonly plan: Plan.Type
  readonly workout: Workout.Type
  readonly exerciseRequests: readonly ExerciseRequest.Type[]
  readonly start: DateTime.Utc
}): Either.Either<Type, WorkoutNotInPlan | ExerciseRequestNotOfPlan | ParseResult.ParseError> => {
  const label = Workout.labelOf(workout)
  if (!plan.action.some((planned) => Workout.labelOf(planned) === label))
    return Either.left(new WorkoutNotInPlan({ workoutLabel: label, planUrl: plan.url }))
  const strayServiceRequestIds = exerciseRequests
    .filter((exerciseRequest) => exerciseRequest.instantiatesCanonical[0] !== plan.url)
    .map((exerciseRequest) => exerciseRequest.id)
  if (Arr.isNonEmptyReadonlyArray(strayServiceRequestIds))
    return Either.left(
      new ExerciseRequestNotOfPlan({ serviceRequestIds: strayServiceRequestIds, planUrl: plan.url })
    )
  return Schema.decodeEither(WorkoutProcedureSchema, { errors: 'all' })({
    ...emptyProcedure,
    id: procedureId,
    status: 'in-progress',
    category: LiftingFeature.concept,
    code: CodeableConcept.make({
      system: WildflowerCodeSystem.Workout,
      code: label,
      display: label,
      text: null,
    }),
    subject,
    instantiatesCanonical: [plan.url],
    basedOn: exerciseRequests.map((exerciseRequest) =>
      IdentifierAndReference.referenceTo({ resourceType: 'ServiceRequest', id: exerciseRequest.id })
    ),
    performedPeriod: { id: null, extension: [], start, end: null },
  })
}

/**
 * The workout done: `completed`, its `performedPeriod` ending at `end`.
 *
 * @returns The completed workout; or a `ParseError` when `end` is before its start
 */
const complete = (
  workoutProcedure: Type,
  end: DateTime.Utc
): Either.Either<Type, ParseResult.ParseError> =>
  Schema.decodeEither(WorkoutProcedureSchema, { errors: 'all' })({
    ...workoutProcedure,
    status: 'completed',
    performedPeriod: { ...workoutProcedure.performedPeriod, end },
  })

/** The workout's coding, as {@link WorkoutCodingSchema} reads it. */
const readWorkoutCoding = Schema.validateOption(WorkoutCodingSchema)

/** The label of the plan's workout this is, from its one workout coding. */
const workoutLabelOf = (workoutProcedure: Type): string =>
  guaranteed(
    pipe(
      CodeableConcept.onlyCodingIn(workoutProcedure.code, WildflowerCodeSystem.Workout),
      Option.flatMap(readWorkoutCoding),
      Option.map((coding) => coding.code)
    )
  )

/** When the workout started. */
const startOf = (workoutProcedure: Type): DateTime.Utc => workoutProcedure.performedPeriod.start

/** When the workout ended; `None` while it is in progress. */
const endOf = (workoutProcedure: Type): Option.Option<DateTime.Utc> =>
  Option.fromNullable(workoutProcedure.performedPeriod.end)

/** The canonical url of the plan the workout belongs to: its one `instantiatesCanonical`. */
const planUrlOf = (workoutProcedure: Type): string => workoutProcedure.instantiatesCanonical[0]

/** The ids of the `ServiceRequest`s the workout carries out, in its `basedOn` order. */
const serviceRequestIdsOf = (workoutProcedure: Type): Arr.NonEmptyReadonlyArray<string> =>
  Arr.map(workoutProcedure.basedOn, (reference) =>
    guaranteed(IdentifierAndReference.referencedIdOf(reference, 'ServiceRequest'))
  )

/** Whether the workout is done — the only kind progression judges. */
const isCompleted = (workoutProcedure: Type): boolean => workoutProcedure.status === 'completed'

/** Earliest first by {@link startOf}. */
const byStart: Order.Order<Type> = Order.mapInput(DateTime.Order, startOf)

/**
 * The completed workouts among `workoutProcedures`, earliest first by start.
 *
 * @remarks
 * A stable sort: workouts started at the same instant keep their input order.
 */
const completedByStart = (workoutProcedures: readonly Type[]): readonly Type[] =>
  Arr.sort(workoutProcedures.filter(isCompleted), byStart)

/** The completed workout among `workoutProcedures` that started last; `None` when none is completed. */
const latestCompleted = (workoutProcedures: readonly Type[]): Option.Option<Type> =>
  Arr.last(completedByStart(workoutProcedures))

export {
  complete,
  ExerciseRequestNotOfPlan,
  completedByStart,
  endOf,
  isCompleted,
  latestCompleted,
  make,
  planUrlOf,
  WorkoutProcedureSchema as Schema,
  serviceRequestIdsOf,
  startOf,
  WorkoutNotInPlan,
  workoutLabelOf,
}
export type { Type }
