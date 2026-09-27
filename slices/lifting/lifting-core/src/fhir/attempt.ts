import { Array as Arr, Data, Either, Option, pipe, Schema } from 'effect'
import { Observation, ObservationComponent } from 'fhir-r4/resources'

import { attemptSucceeded, type ExerciseAttempt } from '../attempt.ts'
import { describeProblem } from '../plan.ts'
import {
  activityCategory,
  exactlyOne,
  exerciseConcept,
  exerciseOf,
  ExerciseUnreadable,
  isCount,
  isMeasure,
  type LiftingMeasure,
  LiftingMeasureCode,
  measureConcept,
  poundsOf,
  poundsQuantity,
  referenceOf,
  referenceTo,
  workoutLabelExtension,
  workoutLabelOf,
} from './elements.ts'

/** A decoded FHIR R4 `Observation`. */
type ObservationResource = Observation.Type

type Component = typeof ObservationComponent.Schema.Type

/** Options for {@link attemptToFhir}. */
interface AttemptToFhirOptions {
  /** The `Observation.id` to write; the app mints it. */
  readonly observationId: string
  /** The patient who performed the attempt, as a literal reference (`Patient/p-1`). */
  readonly subject: string
  /** The id of the `Goal` the attempt was performed against. */
  readonly goalId: string
  /** The id of the `CarePlan` the attempt was performed under. */
  readonly carePlanId: string
}

/** The measures an attempt carries exactly one component for. */
type PrescriptionMeasure =
  | typeof LiftingMeasureCode.LoadLb
  | typeof LiftingMeasureCode.PrescribedSets
  | typeof LiftingMeasureCode.PrescribedReps

/** One reason {@link attemptFromFhir} could not read an `Observation`. */
type AttemptReadProblem =
  | ExerciseUnreadable
  | Data.TaggedEnum<{
      /** There is no single {@link WildflowerExtension.WorkoutLabel} extension with a `valueString`. */
      WorkoutLabelUnreadable: Record<never, never>
      /** There is no `effectiveDateTime`. */
      PerformedAtMissing: Record<never, never>
      /**
       * No single component measures `measure`, or its value is missing or out of
       * range (`load-lb` a non-negative `[lb_av]` quantity with no comparator,
       * the prescription positive integers).
       */
      MeasureUnreadable: { readonly measure: PrescriptionMeasure }
      /** The `index`th (0-based) `reps-completed` component has no non-negative integer. */
      RepsCompletedUnreadable: { readonly index: number }
    }>

/**
 * Constructors and matchers for {@link AttemptReadProblem}. Its
 * `ExerciseUnreadable` variant is the shared one `exerciseGoalFromFhir` also
 * reports.
 */
const AttemptReadProblem = Data.taggedEnum<AttemptReadProblem>()

/** {@link attemptFromFhir} could not read an `Observation`, listing every problem it found. */
class AttemptUnreadable extends Data.TaggedError('AttemptUnreadable')<{
  /** Every reason the attempt could not be read. */
  readonly problems: Arr.NonEmptyReadonlyArray<AttemptReadProblem>
}> {
  // Data.TaggedError leaves `.message` empty by default; name the problems so
  // a logged or thrown refusal says what was wrong.
  override get message(): string {
    return `attempt unreadable: ${this.problems.map(describeProblem).join('; ')}`
  }
}

/** A decoded `Observation` with every optional slot empty, for the attempt's fields to be spread onto. */
const emptyObservation: ObservationResource = Schema.decodeSync(Observation.Schema)({
  resourceType: 'Observation',
  status: 'final',
  code: {},
})

/** A decoded `Observation.component` with every optional slot empty. */
const emptyComponent: Component = Schema.decodeSync(ObservationComponent.Schema)({ code: {} })

/** A component measuring `measure` as a `valueInteger`. */
const countComponent = (measure: LiftingMeasure, count: number): Component => ({
  ...emptyComponent,
  code: measureConcept(measure),
  valueInteger: count,
})

/**
 * An attempt as a FHIR R4 `Observation`: `final`, in the `activity` category
 * (as the Physical Activity IG files exercise), the exercise as its `code`
 * (its name as `text`, so a generic viewer can label it), the goal as `focus`
 * and the plan as `basedOn`, `performedAt` as `effectiveDateTime`,
 * `attemptSucceeded` as `valueBoolean`, the workout label in a
 * {@link WildflowerExtension.WorkoutLabel} extension, and components for the
 * load (`load-lb`, a UCUM `[lb_av]` `valueQuantity`), the prescription
 * (`prescribed-sets`, `prescribed-reps`) and then one `reps-completed` per set
 * performed, in order — all as `valueInteger` but the load.
 *
 * @param attempt - The attempt to write
 * @param options - The ids the app minted for the resource, and the ids of the
 *   subject, goal and plan it points at
 * @returns The decoded `Observation`, ready to encode
 *
 * @remarks
 * `valueBoolean` is for FHIR readers that know nothing of lifting; this
 * package derives success again on read rather than trusting it.
 */
const attemptToFhir = (
  attempt: ExerciseAttempt,
  options: AttemptToFhirOptions
): ObservationResource => ({
  ...emptyObservation,
  id: options.observationId,
  status: 'final',
  category: [activityCategory],
  code: exerciseConcept(attempt.exercise),
  subject: referenceOf(options.subject),
  focus: [referenceTo('Goal', options.goalId)],
  basedOn: [referenceTo('CarePlan', options.carePlanId)],
  effectiveDateTime: attempt.performedAt,
  valueBoolean: attemptSucceeded(attempt),
  extension: [workoutLabelExtension(attempt.workoutLabel)],
  component: [
    {
      ...emptyComponent,
      code: measureConcept(LiftingMeasureCode.LoadLb),
      valueQuantity: poundsQuantity(attempt.loadLb),
    },
    countComponent(LiftingMeasureCode.PrescribedSets, attempt.prescribedSets),
    countComponent(LiftingMeasureCode.PrescribedReps, attempt.prescribedReps),
    ...attempt.repsCompleted.map((setReps) =>
      countComponent(LiftingMeasureCode.RepsCompleted, setReps)
    ),
  ],
})

/** The components measuring `measure`, in component order. */
const componentsFor = (
  observation: ObservationResource,
  measure: LiftingMeasure
): readonly Component[] =>
  observation.component.filter((component) => isMeasure(measure)(component.code))

/** Every reason a field could not be read; never empty. */
type Problems = Arr.NonEmptyReadonlyArray<AttemptReadProblem>

/** The single component measuring `measure`, its value read by `valueOf`. */
const measureOf = (
  observation: ObservationResource,
  measure: PrescriptionMeasure,
  valueOf: (component: Component) => Option.Option<number>
): Either.Either<number, Problems> =>
  pipe(
    exactlyOne(componentsFor(observation, measure)),
    Option.flatMap(valueOf),
    Either.fromOption(() => Arr.of(AttemptReadProblem.MeasureUnreadable({ measure })))
  )

/** A component's `valueInteger`, when it is a positive integer. */
const positiveIntegerOf = (component: Component): Option.Option<number> =>
  pipe(
    Option.fromNullable(component.valueInteger),
    Option.filter((count) => count > 0)
  )

/** Every `reps-completed` count in component order, or each one that is not a non-negative integer. */
const repsCompletedOf = (
  observation: ObservationResource
): Either.Either<readonly number[], Problems> => {
  const [problems, counts] = Arr.partitionMap(
    componentsFor(observation, LiftingMeasureCode.RepsCompleted),
    (component, index) =>
      pipe(
        Option.fromNullable(component.valueInteger),
        Option.filter(isCount),
        Either.fromOption(() => AttemptReadProblem.RepsCompletedUnreadable({ index }))
      )
  )
  return Arr.match(problems, {
    onEmpty: () => Either.right(counts),
    onNonEmpty: (found) => Either.left(found),
  })
}

/**
 * The attempt a FHIR R4 `Observation` written by {@link attemptToFhir} holds.
 *
 * @param observation - A decoded `Observation`
 * @returns
 *   - `Right(Some(attempt))` — the attempt
 *   - `Right(None)` — the observation is retracted (`cancelled` or
 *     `entered-in-error`, fhir-r4's `Observation.RETRACTED_STATUSES`): it
 *     never happened, so there is no attempt to read — a legitimate skip, not
 *     a failure
 *   - `Left` — {@link AttemptUnreadable} listing every
 *     {@link AttemptReadProblem}: no single exercise coding (with display),
 *     workout label or `effectiveDateTime`; not exactly one `load-lb`,
 *     `prescribed-sets` or `prescribed-reps` component in range; or a
 *     `reps-completed` component without a non-negative integer
 *
 * @remarks
 * Not the exact inverse of {@link attemptToFhir}: `focus`, `basedOn`,
 * `subject` and `valueBoolean` are not read. Success is derived from the reps
 * completed, so a stored flag that disagrees cannot mislead the progression;
 * and the app scopes its Observation search to one plan with
 * `based-on=CarePlan/<id>`, so attempts under another plan never reach this
 * reader. Every `reps-completed` component must hold a count — dropping one
 * would shorten the attempt and could turn a failure into a success.
 */
const attemptFromFhir = (
  observation: ObservationResource
): Either.Either<Option.Option<ExerciseAttempt>, AttemptUnreadable> => {
  if (Observation.RETRACTED_STATUSES.has(observation.status)) return Either.right(Option.none())
  const reads = {
    exercise: Either.fromOption(exerciseOf(observation.code), () => Arr.of(ExerciseUnreadable())),
    workoutLabel: Either.fromOption(workoutLabelOf(observation.extension), () =>
      Arr.of(AttemptReadProblem.WorkoutLabelUnreadable())
    ),
    performedAt: Either.fromOption(Option.fromNullable(observation.effectiveDateTime), () =>
      Arr.of(AttemptReadProblem.PerformedAtMissing())
    ),
    loadLb: measureOf(observation, LiftingMeasureCode.LoadLb, (component) =>
      poundsOf(component.valueQuantity)
    ),
    prescribedSets: measureOf(observation, LiftingMeasureCode.PrescribedSets, positiveIntegerOf),
    prescribedReps: measureOf(observation, LiftingMeasureCode.PrescribedReps, positiveIntegerOf),
    repsCompleted: repsCompletedOf(observation),
  }
  return pipe(
    Arr.match(Arr.getLefts(Object.values(reads)).flat(), {
      onNonEmpty: (problems): Either.Either<ExerciseAttempt, Problems> => Either.left(problems),
      onEmpty: () => Either.all(reads),
    }),
    Either.map(Option.some),
    Either.mapLeft((problems) => new AttemptUnreadable({ problems }))
  )
}

export { AttemptReadProblem, attemptFromFhir, attemptToFhir, AttemptUnreadable }
export type { AttemptToFhirOptions, ObservationResource }
