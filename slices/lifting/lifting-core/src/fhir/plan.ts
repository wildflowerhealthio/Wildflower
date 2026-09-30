import { Array as Arr, Data, DateTime, Either, Option, pipe, Schema } from 'effect'
import { type Extension, WildflowerExtension } from 'fhir-r4/data-types'
import { PlanDefinition, PlanDefinitionAction } from 'fhir-r4/resources'

import { exercisesFor } from '../cycle.ts'
import {
  describeProblem,
  type ExerciseOutOfRange,
  type LoadUnit,
  makePlan,
  outOfRangeFieldsOf,
  type Plan,
  type PlannedExercise,
  PlanProblem,
  type ProgressionRule,
  type Workout,
} from '../plan.ts'
import {
  countAmong,
  countConcept,
  exactlyOne,
  exerciseAmong,
  exerciseConcept,
  ExerciseUnreadable,
  extensionAt,
  liftingFeatureConcept,
  LiftingMeasureCode,
  LiftingProgressionPart,
  type LiftingProgressionPartName,
  onlyExtensionAt,
  planUrlOf,
} from './elements.ts'

/** A decoded FHIR R4 `PlanDefinition`. */
type PlanDefinitionResource = PlanDefinition.Type

type Action = PlanDefinitionAction.Type

/** Options for {@link planToFhir}. */
interface PlanToFhirOptions {
  /** The `PlanDefinition.id` to write; the app mints it. Its canonical `url` derives from it. */
  readonly planDefinitionId: string
  /** When the plan was made, written as `PlanDefinition.date`. */
  readonly date: DateTime.Utc
}

/**
 * A plan as it is stored: the plan, the id its `PlanDefinition` is stored
 * under, and the canonical `url` the lifter's requests instantiate — what an
 * app needs to rewrite the same resource and to issue requests against it.
 */
interface StoredPlan {
  /** The plan the resource holds. */
  readonly plan: Plan
  /** The `PlanDefinition.id` the plan is stored under. */
  readonly planDefinitionId: string
  /** `PlanDefinition.url`, as a `ServiceRequest.instantiatesCanonical` names it. */
  readonly url: string
}

/** One reason an exercise action could not be read as a `PlannedExercise`. */
type ExerciseActionProblem =
  | ExerciseUnreadable
  | ExerciseOutOfRange
  | Data.TaggedEnum<{
      /** No single `code` concept measures `measure`, or its value extension has no `valueInteger`; one out of range is an `ExerciseOutOfRange`. */
      MeasureUnreadable: {
        readonly measure: typeof LiftingMeasureCode.Sets | typeof LiftingMeasureCode.Reps
      }
      /** There is no single {@link WildflowerExtension.LiftingProgression} extension. */
      ProgressionUnreadable: Record<never, never>
      /** The progression extension has no single `part` sub-extension carrying its value type. */
      ProgressionPartUnreadable: { readonly part: LiftingProgressionPartName }
    }>

/** Constructors and matchers for {@link ExerciseActionProblem}. */
const ExerciseActionProblem = Data.taggedEnum<ExerciseActionProblem>()

/** One reason {@link planFromFhir} could not read a `PlanDefinition`, beyond a {@link PlanProblem}. */
type PlanReadProblem = Data.TaggedEnum<{
  /** The `PlanDefinition` has no `id`, so there is nothing to store an edit under. */
  PlanDefinitionIdMissing: Record<never, never>
  /** The `PlanDefinition` has no `url`, so no request can instantiate it. */
  UrlMissing: Record<never, never>
  /** Workout action `index` (0-based) has no `title` to be its label. */
  WorkoutUntitled: { readonly index: number }
  /** Exercise action `index` under workout action `workoutIndex` (both 0-based) could not be read. */
  ExerciseActionUnreadable: {
    readonly workoutIndex: number
    readonly index: number
    readonly problems: Arr.NonEmptyReadonlyArray<ExerciseActionProblem>
  }
  /** The exercise is run by more than one workout, and their actions plan it differently. */
  ExerciseDefinitionsDiffer: { readonly exerciseId: string }
}>

/** Constructors and matchers for {@link PlanReadProblem}. */
const PlanReadProblem = Data.taggedEnum<PlanReadProblem>()

/**
 * A `PlanDefinition` could not be read back as a {@link Plan}.
 *
 * @remarks
 * Reading reports every problem it finds rather than stopping at the first, so
 * a UI can say everything that is wrong at once. The plan-level problems are
 * the ones `makePlan` reports, over what could be read.
 */
class PlanUnreadable extends Data.TaggedError('PlanUnreadable')<{
  /** Every reason the plan could not be read. */
  readonly problems: Arr.NonEmptyReadonlyArray<PlanReadProblem | PlanProblem>
}> {
  // Data.TaggedError leaves `.message` empty by default; name the problems so
  // a logged or thrown refusal says what was wrong.
  override get message(): string {
    return `plan unreadable: ${this.problems.map(describeProblem).join('; ')}`
  }
}

/** A decoded `PlanDefinition.action` with every slot empty, for a workout's or exercise's fields to be spread onto. */
const emptyAction: Action = Schema.decodeSync(PlanDefinitionAction.Schema)({})

/** A decoded `PlanDefinition` with every optional slot empty, for the plan's fields to be spread onto. */
const emptyPlanDefinition: PlanDefinitionResource = Schema.decodeSync(PlanDefinition.Schema)({
  resourceType: 'PlanDefinition',
  status: 'active',
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
    { ...extensionAt(LiftingProgressionPart.Unit), valueString: progression.unit },
    decimalPart(LiftingProgressionPart.Increment, progression.increment),
    {
      ...extensionAt(LiftingProgressionPart.FailuresBeforeDeload),
      valueInteger: progression.failuresBeforeDeload,
    },
    decimalPart(LiftingProgressionPart.DeloadFraction, progression.deloadFraction),
    decimalPart(LiftingProgressionPart.MinimumLoad, progression.minimumLoad),
    decimalPart(LiftingProgressionPart.LoadStep, progression.loadStep),
  ],
})

/**
 * A planned exercise as a `PlanDefinition.action`: the exercise, then the
 * `sets` and `reps` measures, as its `code`s, and the progression rule as a
 * {@link WildflowerExtension.LiftingProgression} extension.
 */
const exerciseAction = (planned: PlannedExercise): Action => ({
  ...emptyAction,
  title: planned.exercise.name,
  code: [
    exerciseConcept(planned.exercise),
    countConcept(LiftingMeasureCode.Sets, planned.sets),
    countConcept(LiftingMeasureCode.Reps, planned.reps),
  ],
  extension: [progressionExtension(planned.progression)],
})

/** A workout as a `PlanDefinition.action`: its label as the `title`, one exercise action per exercise, in order. */
const workoutAction = (plan: Plan, workout: Workout): Action => ({
  ...emptyAction,
  title: workout.label,
  action: exercisesFor(plan, workout).map(exerciseAction),
})

/**
 * A plan as a FHIR R4 `PlanDefinition`: `active`, its canonical `url` derived
 * from the id, `title`, `date`, the `strength-training` feature as its
 * `topic`, and one action per workout (the label as `title`) holding one
 * sub-action per exercise, in cycle order — each sub-action naming the
 * exercise and its `sets` and `reps` in `code`, with the progression rule as
 * a {@link WildflowerExtension.LiftingProgression} extension of one
 * {@link LiftingProgressionPart} sub-extension per field.
 *
 * @param plan - The plan to write
 * @param options - The id the app minted for the resource, and when the plan was made
 * @returns The decoded `PlanDefinition`, ready to encode
 *
 * @remarks
 * An exercise in two workouts (StrongLifts' squat) is written under each,
 * identically; the reader refuses a definition whose copies differ. The
 * definition is the program alone — no load, no lifter: a lifter's loads are
 * their `ServiceRequest`s, which name this resource's `url` in
 * `instantiatesCanonical`.
 */
const planToFhir = (plan: Plan, options: PlanToFhirOptions): PlanDefinitionResource => ({
  ...emptyPlanDefinition,
  id: options.planDefinitionId,
  url: planUrlOf(options.planDefinitionId),
  status: 'active',
  title: plan.title,
  date: DateTime.formatIso(options.date),
  topic: [liftingFeatureConcept],
  action: plan.workouts.map((workout) => workoutAction(plan, workout)),
})

/** Every reason a part could not be read; never empty. */
type ActionProblems = Arr.NonEmptyReadonlyArray<ExerciseActionProblem>

/** The single `part` sub-extension of the progression extension, its value read by `valueOf`. */
const partOf = <A>(
  progression: Extension.Type,
  part: LiftingProgressionPartName,
  valueOf: (extension: Extension.Type) => Option.Option<A>
): Either.Either<A, ActionProblems> =>
  pipe(
    onlyExtensionAt(progression.extension, part),
    Option.flatMap(valueOf),
    Either.fromOption(() => Arr.of(ExerciseActionProblem.ProgressionPartUnreadable({ part })))
  )

/** A sub-extension's `valueDecimal`. */
const decimalOf = (extension: Extension.Type): Option.Option<number> =>
  Option.fromNullable(extension.valueDecimal)

/** A sub-extension's `valueString`, when it names a load unit. */
const unitOf = (extension: Extension.Type): Option.Option<LoadUnit> =>
  pipe(
    Option.fromNullable(extension.valueString),
    Option.filter((code): code is LoadUnit => code === 'lb' || code === 'kg')
  )

/** The progression rule the single progression extension carries, or every part that could not be read. */
const progressionOf = (action: Action): Either.Either<ProgressionRule, ActionProblems> =>
  Option.match(onlyExtensionAt(action.extension, WildflowerExtension.LiftingProgression), {
    onNone: () => Either.left(Arr.of(ExerciseActionProblem.ProgressionUnreadable())),
    onSome: (progression) => {
      const parts = {
        unit: partOf(progression, LiftingProgressionPart.Unit, unitOf),
        increment: partOf(progression, LiftingProgressionPart.Increment, decimalOf),
        failuresBeforeDeload: partOf(
          progression,
          LiftingProgressionPart.FailuresBeforeDeload,
          (extension) => Option.fromNullable(extension.valueInteger)
        ),
        deloadFraction: partOf(progression, LiftingProgressionPart.DeloadFraction, decimalOf),
        minimumLoad: partOf(progression, LiftingProgressionPart.MinimumLoad, decimalOf),
        loadStep: partOf(progression, LiftingProgressionPart.LoadStep, decimalOf),
      }
      return Arr.match(Arr.getLefts(Object.values(parts)).flat(), {
        onNonEmpty: (problems) => Either.left(problems),
        onEmpty: () => Either.all(parts),
      })
    },
  })

/** The planned exercise, or each of its fields out of range as `makePlan`'s own `ExerciseOutOfRange`. */
const inRange = (planned: PlannedExercise): Either.Either<PlannedExercise, ActionProblems> =>
  Arr.match(outOfRangeFieldsOf(planned), {
    onEmpty: () => Either.right(planned),
    onNonEmpty: (fields) =>
      Either.left(
        Arr.map(fields, (field) =>
          PlanProblem.ExerciseOutOfRange({ exerciseId: planned.exercise.id, field })
        )
      ),
  })

/** The single `measure` count among an action's codes. */
const countOf = (
  action: Action,
  measure: typeof LiftingMeasureCode.Sets | typeof LiftingMeasureCode.Reps
): Either.Either<number, ActionProblems> =>
  Either.fromOption(countAmong(action.code, measure), () =>
    Arr.of(ExerciseActionProblem.MeasureUnreadable({ measure }))
  )

/**
 * The planned exercise an exercise action written by {@link exerciseAction}
 * holds, or every problem with it.
 */
const plannedExerciseOf = (action: Action): Either.Either<PlannedExercise, ActionProblems> => {
  const reads = {
    exercise: Either.fromOption(exerciseAmong(action.code), () => Arr.of(ExerciseUnreadable())),
    sets: countOf(action, LiftingMeasureCode.Sets),
    reps: countOf(action, LiftingMeasureCode.Reps),
    progression: progressionOf(action),
  }
  return pipe(
    Arr.match(Arr.getLefts(Object.values(reads)).flat(), {
      onNonEmpty: (problems): Either.Either<PlannedExercise, ActionProblems> =>
        Either.left(problems),
      onEmpty: () => Either.all(reads),
    }),
    Either.flatMap(inRange)
  )
}

/** Whether two planned exercises plan the same thing, field by field. */
const samePlannedExercise = (left: PlannedExercise, right: PlannedExercise): boolean =>
  left.exercise.id === right.exercise.id &&
  left.exercise.name === right.exercise.name &&
  left.sets === right.sets &&
  left.reps === right.reps &&
  left.progression.unit === right.progression.unit &&
  left.progression.increment === right.progression.increment &&
  left.progression.failuresBeforeDeload === right.progression.failuresBeforeDeload &&
  left.progression.deloadFraction === right.progression.deloadFraction &&
  left.progression.minimumLoad === right.progression.minimumLoad &&
  left.progression.loadStep === right.progression.loadStep

/** One workout action read: its label and the exercises its sub-actions plan, in order. */
interface WorkoutRead {
  readonly label: string
  readonly exercises: readonly PlannedExercise[]
}

/** A workout action's label and planned exercises, with every problem in it. */
const workoutOf = (
  action: Action,
  workoutIndex: number
): readonly [readonly PlanReadProblem[], WorkoutRead] => {
  const [problems, exercises] = Arr.partitionMap(action.action, (subAction, index) =>
    Either.mapLeft(plannedExerciseOf(subAction), (found) =>
      PlanReadProblem.ExerciseActionUnreadable({ workoutIndex, index, problems: found })
    )
  )
  const label = Option.fromNullable(action.title)
  return [
    [
      ...(Option.isNone(label) ? [PlanReadProblem.WorkoutUntitled({ index: workoutIndex })] : []),
      ...problems,
    ],
    { label: Option.getOrElse(label, () => ''), exercises },
  ]
}

/**
 * Each exercise planned once across the workouts, or the ones whose copies
 * under different workouts differ.
 */
const distinctExercisesOf = (
  workouts: readonly WorkoutRead[]
): readonly [readonly PlanReadProblem[], readonly PlannedExercise[]] => {
  const all = workouts.flatMap((workout) => workout.exercises)
  const byId = Arr.groupBy(all, (planned) => planned.exercise.id)
  const differing = Object.entries(byId)
    .filter(([, copies]) => copies.some((copy) => !samePlannedExercise(copy, copies[0])))
    .map(([exerciseId]) => PlanReadProblem.ExerciseDefinitionsDiffer({ exerciseId }))
  return [differing, Arr.dedupeWith(all, (left, right) => left.exercise.id === right.exercise.id)]
}

/**
 * The stored plan a `PlanDefinition` written by {@link planToFhir} holds.
 *
 * @param planDefinition - A decoded `PlanDefinition`
 * @returns The {@link StoredPlan} — the plan, the `PlanDefinition` id and its
 *   `url` — or {@link PlanUnreadable} listing every problem: each
 *   {@link PlanReadProblem} (no `id`, no `url`, a workout action without a
 *   title, an exercise action that could not be read — no single exercise
 *   coding, `sets` or `reps` measure, or progression extension or part, or a
 *   field out of range — and an exercise whose copies under two workouts
 *   differ), and each `PlanProblem` `makePlan` finds in what could be read
 *   (no title, an empty workout, …)
 *
 * @remarks
 * All-or-nothing, so nothing disappears silently: a plan missing one exercise
 * cannot run its workouts, so it is refused whole rather than read with the
 * exercise quietly dropped. An unreadable exercise action therefore also
 * shows up as whatever `makePlan` finds in the workout it leaves shorter.
 * `status` is not checked — the caller decides which definitions are current.
 */
const planFromFhir = (
  planDefinition: PlanDefinitionResource
): Either.Either<StoredPlan, PlanUnreadable> => {
  const planDefinitionId = Either.fromNullable(planDefinition.id, () =>
    PlanReadProblem.PlanDefinitionIdMissing()
  )
  const url = Either.fromNullable(planDefinition.url, () => PlanReadProblem.UrlMissing())
  const workoutReads = planDefinition.action.map(workoutOf)
  const workouts = workoutReads.map(([, workout]) => workout)
  const [differing, exercises] = distinctExercisesOf(workouts)
  const planRead = makePlan({
    title: planDefinition.title ?? '',
    exercises,
    workouts: workouts.map((workout) => ({
      label: workout.label,
      exerciseIds: workout.exercises.map((planned) => planned.exercise.id),
    })),
  })
  const problems = [
    ...Arr.getLefts([planDefinitionId, url]),
    ...workoutReads.flatMap(([found]) => found),
    ...differing,
    ...Either.match(planRead, { onLeft: (invalid) => invalid.problems, onRight: () => [] }),
  ]
  return Arr.match(problems, {
    onNonEmpty: (found) => Either.left(new PlanUnreadable({ problems: found })),
    onEmpty: () =>
      Either.all({
        plan: Either.mapLeft(planRead, (invalid) => invalid.problems),
        planDefinitionId: Either.mapLeft(planDefinitionId, Arr.of),
        url: Either.mapLeft(url, Arr.of),
      }).pipe(Either.mapLeft((found) => new PlanUnreadable({ problems: found }))),
  })
}

/** The one stored plan among several with the given `url`; `None` when none or several carry it. */
const storedPlanAt = (storedPlans: readonly StoredPlan[], url: string): Option.Option<StoredPlan> =>
  exactlyOne(storedPlans.filter((stored) => stored.url === url))

export {
  ExerciseActionProblem,
  planFromFhir,
  PlanReadProblem,
  planToFhir,
  PlanUnreadable,
  storedPlanAt,
}
export type { PlanDefinitionResource, PlanToFhirOptions, StoredPlan }
