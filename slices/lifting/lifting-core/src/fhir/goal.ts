import { Array as Arr, Data, Either, Option, pipe, Schema } from 'effect'
import { type Extension, WildflowerExtension } from 'fhir-r4/data-types'
import { Goal, GoalTarget } from 'fhir-r4/resources'

import {
  describeProblem,
  type ExerciseGoal,
  type GoalOutOfRange,
  outOfRangeFieldsOf,
  PlanProblem,
  type ProgressionRule,
} from '../plan.ts'
import {
  exactlyOne,
  exerciseConcept,
  exerciseOf,
  ExerciseUnreadable,
  extensionAt,
  isMeasure,
  type LiftingMeasure,
  LiftingMeasureCode,
  LiftingProgressionPart,
  type LiftingProgressionPartName,
  measureConcept,
  onlyExtensionAt,
  poundsOf,
  poundsQuantity,
  referenceOf,
} from './elements.ts'

/** A decoded FHIR R4 `Goal`. */
type GoalResource = Goal.Type

type Target = typeof GoalTarget.Schema.Type

/** Options for {@link exerciseGoalToFhir}. */
interface ExerciseGoalToFhirOptions {
  /** The `Goal.id` to write; the app mints it. */
  readonly goalId: string
  /** The patient the goal is for, as a literal reference (`Patient/p-1`). */
  readonly subject: string
}

/** One reason {@link exerciseGoalFromFhir} could not read a `Goal`. */
type GoalReadProblem =
  | ExerciseUnreadable
  | GoalOutOfRange
  | Data.TaggedEnum<{
      /** No single target measures `measure`, or its detail is missing, of the wrong type, or not in `[lb_av]`. */
      TargetUnreadable: { readonly measure: LiftingMeasure }
      /** There is no single {@link WildflowerExtension.LiftingProgression} extension. */
      ProgressionUnreadable: Record<never, never>
      /** The progression extension has no single `part` sub-extension carrying its value type. */
      ProgressionPartUnreadable: { readonly part: LiftingProgressionPartName }
    }>

/**
 * Constructors and matchers for {@link GoalReadProblem}. Its
 * `ExerciseUnreadable` and `GoalOutOfRange` variants are the shared ones — the
 * same problem `attemptFromFhir` and `makePlan` report.
 */
const GoalReadProblem = Data.taggedEnum<GoalReadProblem>()

/** {@link exerciseGoalFromFhir} could not read a `Goal`, listing every problem it found. */
class GoalUnreadable extends Data.TaggedError('GoalUnreadable')<{
  /** Every reason the goal could not be read. */
  readonly problems: Arr.NonEmptyReadonlyArray<GoalReadProblem>
}> {
  // Data.TaggedError leaves `.message` empty by default; name the problems so
  // a logged or thrown refusal says what was wrong.
  override get message(): string {
    return `goal unreadable: ${this.problems.map(describeProblem).join('; ')}`
  }
}

/** A decoded `Goal.target` with every slot empty, for a measure and a detail to be spread onto. */
const emptyTarget: Target = Schema.decodeSync(GoalTarget.Schema)({})

/** A decoded `Goal` with every optional slot empty, for the lifting fields to be spread onto. */
const emptyGoal: GoalResource = Schema.decodeSync(Goal.Schema)({
  resourceType: 'Goal',
  lifecycleStatus: 'active',
  description: {},
  subject: {},
})

/** A sub-extension carrying a `valueDecimal`. */
const decimalPart = (part: LiftingProgressionPartName, value: number): Extension.Type => ({
  ...extensionAt(part),
  valueDecimal: value,
})

/** The {@link WildflowerExtension.LiftingProgression} complex extension for a rule. */
const progressionExtension = (progression: ProgressionRule): Extension.Type => ({
  ...extensionAt(WildflowerExtension.LiftingProgression),
  extension: [
    decimalPart(LiftingProgressionPart.IncrementLb, progression.incrementLb),
    {
      ...extensionAt(LiftingProgressionPart.FailuresBeforeDeload),
      valueInteger: progression.failuresBeforeDeload,
    },
    decimalPart(LiftingProgressionPart.DeloadFraction, progression.deloadFraction),
    decimalPart(LiftingProgressionPart.MinimumLoadLb, progression.minimumLoadLb),
    decimalPart(LiftingProgressionPart.LoadStepLb, progression.loadStepLb),
  ],
})

/**
 * An exercise goal as a FHIR R4 `Goal`: `active`, the exercise as the coded
 * `description`, one `target` per measure (`load-lb` as a UCUM `[lb_av]`
 * `detailQuantity`, `sets` and `reps` as `detailInteger`), and the
 * progression rule as a {@link WildflowerExtension.LiftingProgression}
 * extension with one {@link LiftingProgressionPart} sub-extension per field.
 *
 * @param goal - The exercise goal to write
 * @param options - The ids the app minted for the resource and its subject
 * @returns The decoded `Goal`, ready to encode
 *
 * @remarks
 * `startDate` and `target.dueDate` stay empty: a strength goal has no due
 * date, and the R4 `date` slot is lossy for anything finer than a day.
 */
const exerciseGoalToFhir = (
  goal: ExerciseGoal,
  options: ExerciseGoalToFhirOptions
): GoalResource => ({
  ...emptyGoal,
  id: options.goalId,
  lifecycleStatus: 'active',
  description: exerciseConcept(goal.exercise),
  subject: referenceOf(options.subject),
  target: [
    {
      ...emptyTarget,
      measure: measureConcept(LiftingMeasureCode.LoadLb),
      detailQuantity: poundsQuantity(goal.loadLb),
    },
    { ...emptyTarget, measure: measureConcept(LiftingMeasureCode.Sets), detailInteger: goal.sets },
    { ...emptyTarget, measure: measureConcept(LiftingMeasureCode.Reps), detailInteger: goal.reps },
  ],
  extension: [progressionExtension(goal.progression)],
})

/** Every reason a field could not be read; never empty. */
type Problems = Arr.NonEmptyReadonlyArray<GoalReadProblem>

/** The single target measuring `measure`, its detail read by `detailOf`. */
const targetOf = <A>(
  goal: GoalResource,
  measure: LiftingMeasure,
  detailOf: (target: Target) => Option.Option<A>
): Either.Either<A, Problems> =>
  pipe(
    exactlyOne(goal.target.filter((target) => isMeasure(measure)(target.measure))),
    Option.flatMap(detailOf),
    Either.fromOption(() => Arr.of(GoalReadProblem.TargetUnreadable({ measure })))
  )

/** The single `part` sub-extension of the progression extension, its value read by `valueOf`. */
const partOf = (
  progression: Extension.Type,
  part: LiftingProgressionPartName,
  valueOf: (extension: Extension.Type) => number | null
): Either.Either<number, Problems> =>
  pipe(
    onlyExtensionAt(progression.extension, part),
    Option.flatMap((extension) => Option.fromNullable(valueOf(extension))),
    Either.fromOption(() => Arr.of(GoalReadProblem.ProgressionPartUnreadable({ part })))
  )

/** A sub-extension's `valueDecimal`. */
const decimalOf = (extension: Extension.Type): number | null => extension.valueDecimal

/** The progression rule the single progression extension carries, or every part that could not be read. */
const progressionOf = (goal: GoalResource): Either.Either<ProgressionRule, Problems> =>
  Option.match(onlyExtensionAt(goal.extension, WildflowerExtension.LiftingProgression), {
    onNone: () => Either.left(Arr.of(GoalReadProblem.ProgressionUnreadable())),
    onSome: (progression) => {
      const parts = {
        incrementLb: partOf(progression, LiftingProgressionPart.IncrementLb, decimalOf),
        failuresBeforeDeload: partOf(
          progression,
          LiftingProgressionPart.FailuresBeforeDeload,
          (extension) => extension.valueInteger
        ),
        deloadFraction: partOf(progression, LiftingProgressionPart.DeloadFraction, decimalOf),
        minimumLoadLb: partOf(progression, LiftingProgressionPart.MinimumLoadLb, decimalOf),
        loadStepLb: partOf(progression, LiftingProgressionPart.LoadStepLb, decimalOf),
      }
      return Arr.match(Arr.getLefts(Object.values(parts)).flat(), {
        onNonEmpty: (problems) => Either.left(problems),
        onEmpty: () => Either.all(parts),
      })
    },
  })

/** The goal, or each of its fields out of range as `makePlan`'s own `GoalOutOfRange`. */
const inRange = (goal: ExerciseGoal): Either.Either<ExerciseGoal, Problems> =>
  Arr.match(outOfRangeFieldsOf(goal), {
    onEmpty: () => Either.right(goal),
    onNonEmpty: (fields) =>
      Either.left(
        Arr.map(fields, (field) =>
          PlanProblem.GoalOutOfRange({ exerciseId: goal.exercise.id, field })
        )
      ),
  })

/**
 * The exercise goal a FHIR R4 `Goal` written by {@link exerciseGoalToFhir}
 * holds.
 *
 * @param goal - A decoded `Goal`
 * @returns The exercise goal, or {@link GoalUnreadable} listing every
 *   {@link GoalReadProblem}: no single exercise coding (with its display); no
 *   single `load-lb` target in `[lb_av]`, or `sets` / `reps` target as an
 *   integer; no single progression extension, or no single sub-extension per
 *   part; or a field out of the range `makePlan` accepts
 *
 * @remarks
 * All-or-nothing and "exactly one": a goal with a missing or duplicated target
 * cannot be prescribed unambiguously, so it is refused rather than read with a
 * default or the first match. `lifecycleStatus` is not checked — the caller
 * decides which goals are current.
 */
const exerciseGoalFromFhir = (goal: GoalResource): Either.Either<ExerciseGoal, GoalUnreadable> => {
  const reads = {
    exercise: Either.fromOption(exerciseOf(goal.description), () => Arr.of(ExerciseUnreadable())),
    loadLb: targetOf(goal, LiftingMeasureCode.LoadLb, (target) => poundsOf(target.detailQuantity)),
    sets: targetOf(goal, LiftingMeasureCode.Sets, (target) =>
      Option.fromNullable(target.detailInteger)
    ),
    reps: targetOf(goal, LiftingMeasureCode.Reps, (target) =>
      Option.fromNullable(target.detailInteger)
    ),
    progression: progressionOf(goal),
  }
  return pipe(
    Arr.match(Arr.getLefts(Object.values(reads)).flat(), {
      onNonEmpty: (problems): Either.Either<ExerciseGoal, Problems> => Either.left(problems),
      onEmpty: () => Either.all(reads),
    }),
    Either.flatMap(inRange),
    Either.mapLeft((problems) => new GoalUnreadable({ problems }))
  )
}

export { exerciseGoalFromFhir, exerciseGoalToFhir, GoalReadProblem, GoalUnreadable }
export type { ExerciseGoalToFhirOptions, GoalResource }
