import { Array as Arr, Data, DateTime, Either, Option, pipe, Schema } from 'effect'
import { Period } from 'fhir-r4/data-types'
import { Observation } from 'fhir-r4/resources'

import { describeProblem } from '../plan.ts'
import type { SetResult } from '../set-result.ts'
import {
  activityCategory,
  exactlyOne,
  exerciseConcept,
  exerciseOf,
  ExerciseUnreadable,
  referencedIdOf,
  referenceOf,
  referenceTo,
  workoutLabelExtension,
  workoutLabelOf,
} from './elements.ts'

/** A decoded FHIR R4 `Observation`. */
type ObservationResource = Observation.Type

/** Options for {@link setResultToFhir}. */
interface SetResultToFhirOptions {
  /** The `Observation.id` to write; the app mints it. */
  readonly observationId: string
  /** The lifter who performed the set, as a literal reference (`Patient/p-1`). */
  readonly subject: string
  /** The id of the `ServiceRequest` the set was performed against. */
  readonly requestId: string
}

/** A set as it is stored: the set and the id of the request it was logged against. */
interface StoredSetResult {
  /** The set the resource holds. */
  readonly set: SetResult
  /** The `ServiceRequest.id` the set is `basedOn`. */
  readonly requestId: string
}

/** One reason {@link setResultFromFhir} could not read an `Observation`. */
type SetReadProblem =
  | ExerciseUnreadable
  | Data.TaggedEnum<{
      /** There is no single {@link WildflowerExtension.WorkoutLabel} extension with a `valueString`. */
      WorkoutLabelUnreadable: Record<never, never>
      /** There is no `effectivePeriod` with both a `start` and an `end` at or after it. */
      PeriodUnreadable: Record<never, never>
      /** `valueInteger` is missing or not a non-negative integer. */
      RepsUnreadable: Record<never, never>
      /** There is no single `basedOn` reference to a `ServiceRequest`. */
      RequestUnreadable: Record<never, never>
    }>

/**
 * Constructors and matchers for {@link SetReadProblem}. Its
 * `ExerciseUnreadable` variant is the shared one the other readers also
 * report.
 */
const SetReadProblem = Data.taggedEnum<SetReadProblem>()

/** {@link setResultFromFhir} could not read an `Observation`, listing every problem it found. */
class SetUnreadable extends Data.TaggedError('SetUnreadable')<{
  /** Every reason the set could not be read. */
  readonly problems: Arr.NonEmptyReadonlyArray<SetReadProblem>
}> {
  // Data.TaggedError leaves `.message` empty by default; name the problems so
  // a logged or thrown refusal says what was wrong.
  override get message(): string {
    return `set unreadable: ${this.problems.map(describeProblem).join('; ')}`
  }
}

/** A decoded `Observation` with every optional slot empty, for the set's fields to be spread onto. */
const emptyObservation: ObservationResource = Schema.decodeUnknownSync(Observation.Schema)({
  resourceType: 'Observation',
  status: 'final',
  code: {},
})

/** The set's span as a decoded `Period`. */
const periodOf = (set: SetResult): typeof Period.Schema.Type => ({
  id: null,
  extension: [],
  start: set.start,
  end: set.end,
})

/**
 * A set as a FHIR R4 `Observation`: `final`, in the `activity` category (as
 * the Physical Activity IG files exercise), the exercise as its `code` (its
 * name as `text`, so a generic viewer can label it), `basedOn` the request it
 * was performed against, its span as `effectivePeriod`, the reps completed as
 * `valueInteger`, and the workout label in a
 * {@link WildflowerExtension.WorkoutLabel} extension.
 *
 * @param set - The set to write
 * @param options - The id the app minted for the resource, and the ids of the
 *   subject and request it points at
 * @returns The decoded `Observation`, ready to encode
 */
const setResultToFhir = (set: SetResult, options: SetResultToFhirOptions): ObservationResource => ({
  ...emptyObservation,
  id: options.observationId,
  status: 'final',
  category: [activityCategory],
  code: exerciseConcept(set.exercise),
  subject: referenceOf(options.subject),
  basedOn: [referenceTo('ServiceRequest', options.requestId)],
  effectivePeriod: periodOf(set),
  valueInteger: set.reps,
  extension: [workoutLabelExtension(set.workoutLabel)],
})

/**
 * The span a decoded `effective[x]` `Period` slot holds: a `start` and an
 * `end` at or after it.
 *
 * @remarks
 * The slot types as `any` on a decoded resource, so it is re-decoded through
 * `Schema.typeSchema(Period.Schema)` rather than read unchecked.
 */
const spanOf = (
  slot: unknown
): Option.Option<{ readonly start: DateTime.Utc; readonly end: DateTime.Utc }> =>
  pipe(
    Schema.decodeUnknownOption(Schema.typeSchema(Period.Schema))(slot),
    Option.flatMap((period) =>
      Option.all({
        start: Option.fromNullable(period.start),
        end: Option.fromNullable(period.end),
      })
    ),
    Option.filter(({ start, end }) => DateTime.greaterThanOrEqualTo(end, start))
  )

/** The id of the single `basedOn` reference to a `ServiceRequest`. */
const requestIdOf = (observation: ObservationResource): Option.Option<string> =>
  pipe(
    exactlyOne(
      Arr.filterMap(observation.basedOn, (reference) => referencedIdOf(reference, 'ServiceRequest'))
    )
  )

/**
 * The stored set a FHIR R4 `Observation` written by {@link setResultToFhir}
 * holds.
 *
 * @param observation - A decoded `Observation`
 * @returns
 *   - `Right(Some(stored))` — the set and the request it was logged against
 *   - `Right(None)` — the observation is retracted (`cancelled` or
 *     `entered-in-error`, fhir-r4's `Observation.RETRACTED_STATUSES`): the set
 *     never happened, so there is none to read — a legitimate skip, not a
 *     failure
 *   - `Left` — {@link SetUnreadable} listing every {@link SetReadProblem}: no
 *     single exercise coding (with display) or workout label; no
 *     `effectivePeriod` with a start and an end at or after it; a
 *     `valueInteger` that is not a non-negative integer; or no single
 *     `basedOn` `ServiceRequest`
 *
 * @remarks
 * `subject` and `category` are not read: the app scopes its search by patient.
 * `basedOn` is, so an app can read every set of a plan in one search and
 * group them by request.
 */
const setResultFromFhir = (
  observation: ObservationResource
): Either.Either<Option.Option<StoredSetResult>, SetUnreadable> => {
  if (Observation.RETRACTED_STATUSES.has(observation.status)) return Either.right(Option.none())
  const reads = {
    exercise: Either.fromOption(exerciseOf(observation.code), () => Arr.of(ExerciseUnreadable())),
    workoutLabel: Either.fromOption(workoutLabelOf(observation.extension), () =>
      Arr.of(SetReadProblem.WorkoutLabelUnreadable())
    ),
    span: Either.fromOption(spanOf(observation.effectivePeriod), () =>
      Arr.of(SetReadProblem.PeriodUnreadable())
    ),
    reps: pipe(
      Option.fromNullable(observation.valueInteger),
      Option.filter((reps) => Number.isInteger(reps) && reps >= 0),
      Either.fromOption(() => Arr.of(SetReadProblem.RepsUnreadable()))
    ),
    requestId: Either.fromOption(requestIdOf(observation), () =>
      Arr.of(SetReadProblem.RequestUnreadable())
    ),
  }
  return pipe(
    Arr.match(Arr.getLefts(Object.values(reads)).flat(), {
      onNonEmpty: (
        problems
      ): Either.Either<StoredSetResult, Arr.NonEmptyReadonlyArray<SetReadProblem>> =>
        Either.left(problems),
      onEmpty: () =>
        Either.map(
          Either.all(reads),
          ({ exercise, workoutLabel, span, reps, requestId }): StoredSetResult => ({
            set: { exercise, workoutLabel, start: span.start, end: span.end, reps },
            requestId,
          })
        ),
    }),
    Either.map(Option.some),
    Either.mapLeft((problems) => new SetUnreadable({ problems }))
  )
}

export { SetReadProblem, setResultFromFhir, setResultToFhir, SetUnreadable }
export type { ObservationResource, SetResultToFhirOptions, StoredSetResult }
