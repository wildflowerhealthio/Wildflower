import {
  Array as Arr,
  type Brand,
  DateTime,
  type Either,
  Option,
  Order,
  type ParseResult,
  Schema,
} from 'effect'
import { IdentifierAndReference, narrowFields, Period, withMandatoryId } from 'fhir-r4/data-types'
import { Observation } from 'fhir-r4/resources'

// Type-only: a set is made from its `ExerciseRequest` and its workout, but
// both modules read sets at runtime, so importing them back would be a cycle.
import type * as ExerciseRequest from '../exercise-request/exercise-request.ts'
import * as ExerciseConcept from '../exercise/exercise-concept.ts'
import { guaranteed, onlyOneIssues } from '../internal/issues.ts'
import { narrowedFrom } from '../internal/narrowed-from.ts'
import type * as WorkoutProcedure from '../workout-procedure/workout-procedure.ts'

/** The `Observation.status`es of a set that happened: every status but the retracted ones. */
const PerformedStatusSchema = Schema.Literal(
  'registered',
  'preliminary',
  'final',
  'amended',
  'corrected',
  'unknown'
)

/** A decoded `Period` narrowed to a `start` and an `end` at or after it. */
const SpanSchema = narrowFields(Schema.typeSchema(Period.Schema), {
  start: Schema.DateTimeUtcFromSelf,
  end: Schema.DateTimeUtcFromSelf,
}).pipe(
  Schema.filter((span) => DateTime.greaterThanOrEqualTo(span.end, span.start), {
    message: () => 'expected the end at or after the start',
  })
)

/** What an (already decoded) reference to the set's `ServiceRequest` or `Procedure` must carry: its literal. */
const LiteralReferenceSchema = Schema.Struct({ reference: Schema.String })

/** Whether a reference names a resource of `resourceType`. */
const refersTo =
  (resourceType: string) =>
  (reference: IdentifierAndReference.ReferenceType): boolean =>
    Option.isSome(IdentifierAndReference.referencedIdOf(reference, resourceType))

/**
 * One set performed against an `ExerciseRequest` in a workout, as FHIR
 * records it: an `Observation` narrowed to an `id`, a status other than a
 * retracted one, the exercise as its `code`, the set's span as an
 * `effectivePeriod` with a start and an end at or after it, the reps
 * completed as a non-negative `valueInteger`, exactly one `basedOn`
 * reference to the `ServiceRequest` it was performed against, and exactly
 * one `partOf` reference to the workout `Procedure` it was performed in.
 *
 * @remarks
 * The load is not here: the `ExerciseRequest` a set is logged against holds
 * it. Whether a workout met that load is derived from the reps of its sets,
 * never stored. A retracted observation (fhir-r4's
 * `Observation.RETRACTED_STATUSES`) does not decode — the set never happened.
 */
interface Type
  extends
    Omit<Observation.Type, 'id' | 'status' | 'code' | 'effectivePeriod' | 'valueInteger'>,
    Brand.Brand<'ExerciseSetObservation'> {
  /** The id the observation is stored under. */
  readonly id: string
  /** Any status but `cancelled` or `entered-in-error`. */
  readonly status: typeof PerformedStatusSchema.Type
  /** The exercise performed. */
  readonly code: ExerciseConcept.Type
  /** When the set started and ended. */
  readonly effectivePeriod: typeof SpanSchema.Type
  /** Reps completed; a non-negative integer. */
  readonly valueInteger: number
}

/**
 * Decodes an `Observation` into a {@link Type} — fails, naming the field, on
 * anything the type narrows that is missing, repeated or malformed.
 */
const ExerciseSetObservationSchema: Schema.Schema<Type, Observation.Type> =
  narrowedFrom<Observation.Type>()(
    narrowFields(Schema.typeSchema(withMandatoryId(Observation.Schema)), {
      status: PerformedStatusSchema,
      code: Schema.typeSchema(ExerciseConcept.Schema),
      effectivePeriod: SpanSchema,
      valueInteger: Schema.NonNegativeInt,
    }).pipe(
      Schema.filter((observation) => [
        ...onlyOneIssues({
          items: observation.basedOn,
          selected: refersTo('ServiceRequest'),
          schema: LiteralReferenceSchema,
          path: ['basedOn'],
          expected: 'reference to a ServiceRequest',
        }),
        ...onlyOneIssues({
          items: observation.partOf,
          selected: refersTo('Procedure'),
          schema: LiteralReferenceSchema,
          path: ['partOf'],
          expected: 'reference to a Procedure',
        }),
      ]),
      Schema.brand('ExerciseSetObservation')
    )
  )

/** A decoded `Observation` with every optional slot empty, for a set to be spread onto. */
const emptyObservation: Observation.Type = Schema.decodeUnknownSync(Observation.Schema)({
  resourceType: 'Observation',
  status: 'final',
  code: {},
})

/**
 * One set performed against `exerciseRequest` in `workoutProcedure`:
 * `final`, in the `activity` category (as the Physical Activity IG files
 * exercise), the exercise and `subject` of `exerciseRequest`, `basedOn` its
 * `ServiceRequest`, `partOf` the workout's `Procedure`, the span `start` to `end` as `effectivePeriod`, and the
 * `reps` completed as `valueInteger`.
 *
 * @returns The observation, stored under `observationId` (the app mints it);
 *   or a `ParseError` when `end` is before `start` or `reps` is not a
 *   non-negative integer
 */
const make = (set: {
  readonly observationId: string
  readonly exerciseRequest: ExerciseRequest.Type
  readonly workoutProcedure: WorkoutProcedure.Type
  readonly start: DateTime.Utc
  readonly end: DateTime.Utc
  readonly reps: number
}): Either.Either<Type, ParseResult.ParseError> =>
  Schema.decodeEither(ExerciseSetObservationSchema, { errors: 'all' })({
    ...emptyObservation,
    id: set.observationId,
    status: 'final',
    category: [Observation.ACTIVITY_CATEGORY],
    code: set.exerciseRequest.code,
    subject: set.exerciseRequest.subject,
    basedOn: [
      IdentifierAndReference.referenceTo({
        resourceType: 'ServiceRequest',
        id: set.exerciseRequest.id,
      }),
    ],
    partOf: [
      IdentifierAndReference.referenceTo({
        resourceType: 'Procedure',
        id: set.workoutProcedure.id,
      }),
    ],
    effectivePeriod: { id: null, extension: [], start: set.start, end: set.end },
    valueInteger: set.reps,
  })

/** The exercise performed. */
const exerciseOf = (observation: Type): ExerciseConcept.Type => observation.code

/** When the set started. */
const startOf = (observation: Type): DateTime.Utc => observation.effectivePeriod.start

/** When the set ended; not before {@link startOf}. */
const endOf = (observation: Type): DateTime.Utc => observation.effectivePeriod.end

/** Reps completed; a non-negative integer. */
const repsOf = (observation: Type): number => observation.valueInteger

/** The id `references` names for its one `resourceType` — on a value whose schema checked there is one. */
const referencedIdAmong = (
  references: readonly IdentifierAndReference.ReferenceType[],
  resourceType: string
): string =>
  guaranteed(
    Arr.findFirst(references, (reference) =>
      IdentifierAndReference.referencedIdOf(reference, resourceType)
    )
  )

/** The id of the `ServiceRequest` the set was performed against: its one `basedOn`. */
const serviceRequestIdOf = (observation: Type): string =>
  referencedIdAmong(observation.basedOn, 'ServiceRequest')

/** The id of the workout `Procedure` the set was performed in: its one `partOf`. */
const procedureIdOf = (observation: Type): string =>
  referencedIdAmong(observation.partOf, 'Procedure')

/** Earliest first by {@link startOf}. */
const byStart: Order.Order<Type> = Order.mapInput(DateTime.Order, startOf)

/**
 * The set observations earliest first, by {@link startOf}.
 *
 * @remarks
 * A stable sort: sets started at the same instant keep their input order, so
 * of two such sets the later one in the input counts as the more recent.
 */
const sortByStart = (observations: readonly Type[]): readonly Type[] =>
  Arr.sort(observations, byStart)

export {
  endOf,
  ExerciseSetObservationSchema as Schema,
  exerciseOf,
  make,
  procedureIdOf,
  repsOf,
  serviceRequestIdOf,
  sortByStart,
  startOf,
}
export type { Type }
