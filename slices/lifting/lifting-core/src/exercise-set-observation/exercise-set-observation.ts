import {
  Array as Arr,
  type Brand,
  DateTime,
  type Either,
  Option,
  Order,
  type ParseResult,
  pipe,
  Schema,
} from 'effect'
import {
  Extension,
  IdentifierAndReference,
  narrowFields,
  Period,
  WildflowerExtension,
  withMandatoryId,
} from 'fhir-r4/data-types'
import { Observation } from 'fhir-r4/resources'

// Type-only: an observation is made from its `ExerciseRequest`, but that
// module reads observations at runtime, so importing it back would be a cycle.
import type * as ExerciseRequest from '../exercise-request/exercise-request.ts'
import * as ExerciseConcept from '../exercise/exercise-concept.ts'
import { guaranteed, onlyOneIssues } from '../internal/issues.ts'
import { narrowedFrom } from '../internal/narrowed-from.ts'

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

/** What the (already decoded) `WorkoutLabel` extension must carry: its label, as a `valueString`. */
const WorkoutLabelSchema = Schema.Struct({ valueString: Schema.String })

/** A `WorkoutLabel` extension as {@link WorkoutLabelSchema} reads it. */
const readWorkoutLabel = Schema.validateOption(WorkoutLabelSchema)

/** What the (already decoded) one `basedOn` reference to a `ServiceRequest` must carry: its literal. */
const ServiceRequestReferenceSchema = Schema.Struct({ reference: Schema.String })

/** A `basedOn` reference to a `ServiceRequest`. */
const refersToServiceRequest = (reference: IdentifierAndReference.ReferenceType): boolean =>
  Option.isSome(IdentifierAndReference.referencedIdOf(reference, 'ServiceRequest'))

/**
 * One set performed against an `ExerciseRequest`, as FHIR records it: an
 * `Observation` narrowed to an `id`, a status other than a retracted one, the
 * exercise as its `code`, the set's span as an `effectivePeriod` with a start
 * and an end at or after it, the reps completed as a non-negative
 * `valueInteger`, exactly one {@link WildflowerExtension.WorkoutLabel}
 * extension naming the workout the set was part of, and exactly one `basedOn`
 * reference to the `ServiceRequest` it was performed against.
 *
 * @remarks
 * The load is not here: a set is logged against one `ExerciseRequest`, and
 * the `ExerciseRequest` is the load. Whether a session met its `ExerciseRequest` is derived from
 * the reps of its sets, never stored. A retracted observation (fhir-r4's
 * `Observation.RETRACTED_STATUSES`) does not decode — the set never happened;
 * an app that counts skipped sets apart from unreadable ones checks the
 * status before decoding.
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
          items: observation.extension,
          selected: Extension.hasUrl(WildflowerExtension.WorkoutLabel),
          schema: WorkoutLabelSchema,
          path: ['extension'],
          expected: `${WildflowerExtension.WorkoutLabel} extension`,
        }),
        ...onlyOneIssues({
          items: observation.basedOn,
          selected: refersToServiceRequest,
          schema: ServiceRequestReferenceSchema,
          path: ['basedOn'],
          expected: 'reference to a ServiceRequest',
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
 * One set performed against `exerciseRequest`: `final`, in the `activity`
 * category (as the Physical Activity IG files exercise), the `ExerciseRequest`'s
 * exercise as its `code` and its subject as the `subject`, `basedOn` the
 * `ServiceRequest`, the span `start` to `end` as `effectivePeriod`, the `reps`
 * completed as `valueInteger`, and `workoutLabel` in a
 * {@link WildflowerExtension.WorkoutLabel} extension.
 *
 * @returns The observation, stored under `observationId` (the app mints it);
 *   or a `ParseError` when `end` is before `start` or `reps` is not a
 *   non-negative integer
 */
const make = (set: {
  readonly observationId: string
  readonly exerciseRequest: ExerciseRequest.Type
  readonly workoutLabel: string
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
    effectivePeriod: { id: null, extension: [], start: set.start, end: set.end },
    valueInteger: set.reps,
    extension: [
      { ...Extension.emptyAt(WildflowerExtension.WorkoutLabel), valueString: set.workoutLabel },
    ],
  })

/** The exercise performed. */
const exerciseOf = (observation: Type): ExerciseConcept.Type => observation.code

/** The label of the workout the set was part of. */
const workoutLabelOf = (observation: Type): string =>
  guaranteed(
    pipe(
      Extension.onlyAt(observation.extension, WildflowerExtension.WorkoutLabel),
      Option.flatMap(readWorkoutLabel),
      Option.map((extension) => extension.valueString)
    )
  )

/** When the set started. */
const startOf = (observation: Type): DateTime.Utc => observation.effectivePeriod.start

/** When the set ended; not before {@link startOf}. */
const endOf = (observation: Type): DateTime.Utc => observation.effectivePeriod.end

/** Reps completed; a non-negative integer. */
const repsOf = (observation: Type): number => observation.valueInteger

/** The id of the `ServiceRequest` the set was performed against — its one `basedOn` `ServiceRequest`. */
const serviceRequestIdOf = (observation: Type): string =>
  guaranteed(
    Arr.findFirst(observation.basedOn, (reference) =>
      IdentifierAndReference.referencedIdOf(reference, 'ServiceRequest')
    )
  )

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
  repsOf,
  serviceRequestIdOf,
  sortByStart,
  startOf,
  workoutLabelOf,
}
export type { Type }
