import { Array as Arr, Brand, Data, Either, pipe, Record } from 'effect'

/**
 * One strength-training exercise: a stable slug `id` (`squat`,
 * `bench-press`) that attempts and goals are keyed by, and the `name` a
 * person reads.
 */
interface Exercise {
  /** Stable slug identifying the exercise; persisted, so never renamed. */
  readonly id: string
  /** The display name, e.g. `"Bench Press"`. */
  readonly name: string
}

/**
 * How one exercise's load moves between sessions: up by `incrementLb` after a
 * success; after `failuresBeforeDeload` consecutive failures at one load, down
 * by `deloadFraction`, rounded down to a multiple of `loadStepLb` and never
 * below `minimumLoadLb`.
 *
 * @remarks
 * The ranges below are what {@link makePlan} accepts; see `progressGoal` for
 * the whole rule.
 */
interface ProgressionRule {
  /** Pounds added to the load after a successful session; `> 0`. */
  readonly incrementLb: number
  /** Consecutive failed sessions at one load that trigger a deload; a positive integer. */
  readonly failuresBeforeDeload: number
  /** The fraction of the load a deload takes off; strictly between 0 and 1 (e.g. `0.1`). */
  readonly deloadFraction: number
  /**
   * The lightest load a deload may reach, in pounds; `≥ 0`. For a barbell lift
   * it is the empty bar (45 lb).
   */
  readonly minimumLoadLb: number
  /**
   * The smallest change the equipment can make to the load, in pounds; `> 0`.
   * For a barbell it is one pair of the smallest common plates (2 × 2.5 lb).
   */
  readonly loadStepLb: number
}

/**
 * One exercise's current prescription: lift `loadLb` for `sets` × `reps`, and
 * progress by `progression`.
 */
interface ExerciseGoal {
  /** The exercise this goal prescribes. */
  readonly exercise: Exercise
  /** The load to lift, in pounds; at least `progression.minimumLoadLb`. */
  readonly loadLb: number
  /** Sets to perform; a positive integer. */
  readonly sets: number
  /** Reps per set; a positive integer. */
  readonly reps: number
  /** How `loadLb` moves after each session. */
  readonly progression: ProgressionRule
}

/**
 * One workout of a plan's cycle: its `label` (StrongLifts has `"A"` and
 * `"B"`) and the exercises it runs, by {@link Exercise.id}, in the order they
 * are performed.
 */
interface Workout {
  /** The label that identifies this workout within its plan's cycle. */
  readonly label: string
  /** The exercises performed, by id, in order. */
  readonly exerciseIds: Arr.NonEmptyReadonlyArray<string>
}

/**
 * A validated strength-training plan: its `title`, one {@link ExerciseGoal}
 * per exercise, and the workouts that cycle in order. The brand records that
 * it came through {@link makePlan}.
 *
 * @remarks
 * Any edit goes back through {@link makePlan}; `progressPlan` is the one
 * internal step that preserves the invariants by construction. The brand is a
 * type-level marker, so a spread (`{ ...plan, title: '' }`) still type-checks
 * as a `Plan` — don't: rebuild through `makePlan` instead.
 *
 * Invariants {@link makePlan} checks: the title, every workout label and
 * every exercise name are non-blank, and every exercise id is a slug (its own
 * {@link exerciseIdFromName}); there
 * is at least one workout, each running at least one exercise, with distinct
 * labels; each key of `goalsByExerciseId` is the {@link Exercise.id} of the
 * goal it holds; every exercise a workout names has a goal; and every goal is
 * in range (see {@link outOfRangeFieldsOf}). An exercise in more than one
 * workout (StrongLifts' squat) has one goal, shared.
 */
type Plan = {
  /** Human-friendly name, e.g. `"StrongLifts 5×5"`. */
  readonly title: string
  /** The current prescription per exercise, keyed by {@link Exercise.id}. */
  readonly goalsByExerciseId: Readonly<Record<string, ExerciseGoal>>
  /** The workouts in cycle order; after the last comes the first again. */
  readonly workouts: Arr.NonEmptyReadonlyArray<Workout>
} & Brand.Brand<'Plan'>

/** The unvalidated parts of a plan, as {@link makePlan} takes them. */
interface PlanInput {
  /** Human-friendly name; must be non-blank. */
  readonly title: string
  /** One goal per exercise. */
  readonly goals: readonly ExerciseGoal[]
  /** The workouts in cycle order, each naming its exercises by id. */
  readonly workouts: readonly {
    readonly label: string
    readonly exerciseIds: readonly string[]
  }[]
}

/** A field of an {@link ExerciseGoal} (or of its rule) that can be out of range. */
type GoalField =
  | 'loadLb'
  | 'sets'
  | 'reps'
  | 'incrementLb'
  | 'failuresBeforeDeload'
  | 'deloadFraction'
  | 'minimumLoadLb'
  | 'loadStepLb'

/** One reason {@link makePlan} refused a plan. */
type PlanProblem = Data.TaggedEnum<{
  /** The title is empty or only whitespace. */
  TitleEmpty: Record<never, never>
  /** There are no workouts. */
  WorkoutsMissing: Record<never, never>
  /** Workout `index` (0-based) has an empty or whitespace-only label. */
  WorkoutUnlabelled: { readonly index: number }
  /**
   * Goal `index` (0-based) is for an exercise whose id is empty or not a slug
   * — not what {@link exerciseIdFromName} makes of it.
   */
  ExerciseIdNotSlug: { readonly index: number }
  /** The exercise `exerciseId` has an empty or whitespace-only name. */
  ExerciseUnnamed: { readonly exerciseId: string }
  /** A workout runs no exercises. */
  WorkoutEmpty: { readonly label: string }
  /** Two workouts share a label. */
  WorkoutLabelDuplicate: { readonly label: string }
  /** Two goals are for the same exercise. */
  GoalDuplicate: { readonly exerciseId: string }
  /** A goal's field is out of its documented range. */
  GoalOutOfRange: { readonly exerciseId: string; readonly field: GoalField }
  /** A workout names an exercise no goal is for. */
  WorkoutExerciseWithoutGoal: { readonly label: string; readonly exerciseId: string }
}>

/** Constructors and matchers for {@link PlanProblem}. */
const PlanProblem = Data.taggedEnum<PlanProblem>()

/** The one {@link PlanProblem} variant a goal read on its own can also report. */
type GoalOutOfRange = Data.TaggedEnum.Value<PlanProblem, 'GoalOutOfRange'>

/**
 * One tagged problem as a line of text: its tag, then its fields as JSON when
 * it has any — what an error's `message` lists.
 */
const describeProblem = (problem: { readonly _tag: string }): string => {
  const { _tag, ...fields } = problem
  return Object.keys(fields).length === 0 ? _tag : `${_tag} ${JSON.stringify(fields)}`
}

/** {@link makePlan} refused a plan, listing every problem it found. */
class PlanInvalid extends Data.TaggedError('PlanInvalid')<{
  /** Every reason the plan was refused. */
  readonly problems: Arr.NonEmptyReadonlyArray<PlanProblem>
}> {
  // Data.TaggedError leaves `.message` empty by default; name the problems so
  // a logged or thrown refusal says what was wrong.
  override get message(): string {
    return `plan refused: ${this.problems.map(describeProblem).join('; ')}`
  }
}

/** Whether a string holds anything but whitespace. */
const isBlank = (text: string): boolean => text.trim().length === 0

/**
 * The exercise id a display name slugs to: lowercased, diacritics folded,
 * every run of other characters collapsed to one hyphen, and no hyphen at
 * either end — `"Bench Press"` → `bench-press`, `"Développé Couché"` →
 * `developpe-couche`.
 *
 * @remarks
 * Idempotent: an id it produces slugs to itself. Only `[a-z0-9-]` comes out,
 * so a name of nothing but other characters slugs to the empty string, which
 * {@link makePlan} refuses as an id.
 */
const exerciseIdFromName = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** A finite number `≥ 0`. */
const isNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0

/** A finite number `> 0`. */
const isPositive = (value: number): boolean => Number.isFinite(value) && value > 0

/** An integer `> 0`. */
const isPositiveInt = (value: number): boolean => Number.isInteger(value) && value > 0

/**
 * The fields of a goal that are out of range: `loadLb` finite and at least
 * `minimumLoadLb`; `sets`, `reps` and `failuresBeforeDeload` positive
 * integers; `incrementLb` and `loadStepLb` finite and positive;
 * `deloadFraction` strictly between 0 and 1; `minimumLoadLb` finite and
 * non-negative.
 *
 * @returns The out-of-range fields; empty when the goal is valid
 */
const outOfRangeFieldsOf = (goal: ExerciseGoal): readonly GoalField[] => {
  const { progression } = goal
  const checks: readonly (readonly [GoalField, boolean])[] = [
    ['loadLb', isNonNegative(goal.loadLb) && goal.loadLb >= progression.minimumLoadLb],
    ['sets', isPositiveInt(goal.sets)],
    ['reps', isPositiveInt(goal.reps)],
    ['incrementLb', isPositive(progression.incrementLb)],
    ['failuresBeforeDeload', isPositiveInt(progression.failuresBeforeDeload)],
    ['deloadFraction', progression.deloadFraction > 0 && progression.deloadFraction < 1],
    ['minimumLoadLb', isNonNegative(progression.minimumLoadLb)],
    ['loadStepLb', isPositive(progression.loadStepLb)],
  ]
  return checks.filter(([, valid]) => !valid).map(([field]) => field)
}

/** The problems with each goal on its own — its exercise's id and name, its ranges — and with two goals for one exercise. */
const goalProblemsOf = (goals: readonly ExerciseGoal[]): readonly PlanProblem[] => [
  ...goals.flatMap((goal, index) => [
    ...(goal.exercise.id === '' || exerciseIdFromName(goal.exercise.id) !== goal.exercise.id
      ? [PlanProblem.ExerciseIdNotSlug({ index })]
      : []),
    ...(isBlank(goal.exercise.name)
      ? [PlanProblem.ExerciseUnnamed({ exerciseId: goal.exercise.id })]
      : []),
  ]),
  ...goals.flatMap((goal) =>
    outOfRangeFieldsOf(goal).map((field) =>
      PlanProblem.GoalOutOfRange({ exerciseId: goal.exercise.id, field })
    )
  ),
  ...pipe(
    goals.map((goal) => goal.exercise.id),
    (ids) => ids.filter((id, index) => ids.indexOf(id) !== index),
    Arr.dedupe,
    Arr.map((exerciseId) => PlanProblem.GoalDuplicate({ exerciseId }))
  ),
]

/** The problems with the workouts beyond their emptiness: a blank label, a repeated label, an exercise with no goal. */
const workoutProblemsOf = (
  workouts: PlanInput['workouts'],
  goalsByExerciseId: Readonly<Record<string, ExerciseGoal>>
): readonly PlanProblem[] => {
  const labels = workouts.map((workout) => workout.label)
  return [
    ...workouts.flatMap((workout, index) =>
      isBlank(workout.label) ? [PlanProblem.WorkoutUnlabelled({ index })] : []
    ),
    ...Arr.dedupe(labels.filter((label, index) => labels.indexOf(label) !== index)).map((label) =>
      PlanProblem.WorkoutLabelDuplicate({ label })
    ),
    ...workouts.flatMap((workout) =>
      Arr.dedupe(workout.exerciseIds)
        .filter((exerciseId) => !Record.has(goalsByExerciseId, exerciseId))
        .map((exerciseId) =>
          PlanProblem.WorkoutExerciseWithoutGoal({ label: workout.label, exerciseId })
        )
    ),
  ]
}

/**
 * The workouts with each one's non-emptiness carried in its type; or
 * `WorkoutsMissing` when there are none, or `WorkoutEmpty` for each that runs
 * no exercise.
 */
const nonEmptyWorkoutsOf = (
  workouts: PlanInput['workouts']
): Either.Either<Arr.NonEmptyReadonlyArray<Workout>, Arr.NonEmptyReadonlyArray<PlanProblem>> =>
  Arr.match(workouts, {
    onEmpty: () => Either.left(Arr.of(PlanProblem.WorkoutsMissing())),
    onNonEmpty: (given) => {
      const checked = Arr.map(
        given,
        ({ label, exerciseIds }): Either.Either<Workout, PlanProblem> =>
          Arr.isNonEmptyReadonlyArray(exerciseIds)
            ? Either.right({ label, exerciseIds })
            : Either.left(PlanProblem.WorkoutEmpty({ label }))
      )
      return Arr.match(Arr.getLefts(checked), {
        onNonEmpty: (emptyWorkouts) => Either.left(emptyWorkouts),
        onEmpty: () => Either.mapLeft(Either.all(checked), Arr.of),
      })
    },
  })

/**
 * Brands a checked plan. Internal to the package — not exported from its
 * index: `makePlan` calls it after checking every invariant, and
 * `progressPlan` after a step that preserves them by construction.
 *
 * @internal
 */
const brandPlan = Brand.nominal<Plan>()

/**
 * A {@link Plan} from its parts, when they satisfy every plan invariant.
 *
 * @param input - The title, one goal per exercise, and the workouts in cycle order
 * @returns The plan, with its goals keyed by exercise id; or {@link PlanInvalid}
 *   listing every {@link PlanProblem} found, not only the first
 */
const makePlan = (input: PlanInput): Either.Either<Plan, PlanInvalid> => {
  const goalsByExerciseId = Record.fromEntries(
    input.goals.map((goal) => [goal.exercise.id, goal] as const)
  )
  const leadingProblems = [
    ...(isBlank(input.title) ? [PlanProblem.TitleEmpty()] : []),
    ...goalProblemsOf(input.goals),
  ]
  const trailingProblems = workoutProblemsOf(input.workouts, goalsByExerciseId)
  return Either.match(nonEmptyWorkoutsOf(input.workouts), {
    onLeft: (workoutProblems) =>
      Either.left(
        new PlanInvalid({
          problems: Arr.prependAll(
            Arr.appendAll(workoutProblems, trailingProblems),
            leadingProblems
          ),
        })
      ),
    onRight: (workouts) =>
      Arr.match([...leadingProblems, ...trailingProblems], {
        onNonEmpty: (problems) => Either.left(new PlanInvalid({ problems })),
        onEmpty: () => Either.right(brandPlan({ title: input.title, goalsByExerciseId, workouts })),
      }),
  })
}

export {
  brandPlan,
  describeProblem,
  exerciseIdFromName,
  makePlan,
  outOfRangeFieldsOf,
  PlanInvalid,
  PlanProblem,
}
export type {
  Exercise,
  ExerciseGoal,
  GoalField,
  GoalOutOfRange,
  Plan,
  PlanInput,
  ProgressionRule,
  Workout,
}
