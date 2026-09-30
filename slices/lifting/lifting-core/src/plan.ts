import { Array as Arr, Brand, Data, Either, pipe, Record } from 'effect'

/**
 * One strength-training exercise: a stable slug `id` (`squat`,
 * `bench-press`) that prescriptions and sets are keyed by, and the `name` a
 * person reads.
 */
interface Exercise {
  /** Stable slug identifying the exercise; persisted, so never renamed. */
  readonly id: string
  /** The display name, e.g. `"Bench Press"`. */
  readonly name: string
}

/** The units a load is lifted in. Persisted wire format — append, don't rename. */
type LoadUnit = 'lb' | 'kg'

/** A load on the bar: a finite, non-negative `value` in `unit`. */
interface Load {
  /** The amount, finite and `≥ 0`. */
  readonly value: number
  /** The unit `value` is in. */
  readonly unit: LoadUnit
}

/**
 * How one exercise's load moves between sessions: up by `increment` after a
 * success; after `failuresBeforeDeload` consecutive failed sessions, down by
 * `deloadFraction`, rounded down to a multiple of `loadStep` and never below
 * `minimumLoad`. Every amount is in `unit`, and only a load in that unit
 * progresses by this rule.
 *
 * @remarks
 * The ranges below are what {@link makePlan} accepts; see `progressPrescription`
 * for the whole rule.
 */
interface ProgressionRule {
  /** The unit `increment`, `minimumLoad` and `loadStep` are in. */
  readonly unit: LoadUnit
  /** Added to the load after a successful session; `> 0`. */
  readonly increment: number
  /** Consecutive failed sessions at one load that trigger a deload; a positive integer. */
  readonly failuresBeforeDeload: number
  /** The fraction of the load a deload takes off; strictly between 0 and 1 (e.g. `0.1`). */
  readonly deloadFraction: number
  /**
   * The lightest load a deload may reach; `≥ 0`. For a barbell lift it is the
   * empty bar (45 lb, or 20 kg).
   */
  readonly minimumLoad: number
  /**
   * The smallest change the equipment can make to the load; `> 0`. For a
   * barbell it is one pair of the smallest common plates (2 × 2.5 lb).
   */
  readonly loadStep: number
}

/**
 * How a plan runs one exercise: `sets` × `reps` each session, its load moved
 * by `progression`. The load itself is not here — it is the lifter's, on their
 * current `Prescription`.
 */
interface PlannedExercise {
  /** The exercise this plans. */
  readonly exercise: Exercise
  /** Sets to perform each session; a positive integer. */
  readonly sets: number
  /** Reps per set; a positive integer. */
  readonly reps: number
  /** How the load moves after each session. */
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
 * A validated strength-training plan: its `title`, one {@link PlannedExercise}
 * per exercise, and the workouts that cycle in order. The brand records that
 * it came through {@link makePlan}.
 *
 * @remarks
 * A plan is the program, not the lifter's state: it says how each exercise is
 * run and how its load moves, never what the load is. Any edit goes back
 * through {@link makePlan}. The brand is a type-level marker, so a spread
 * (`{ ...plan, title: '' }`) still type-checks as a `Plan` — don't: rebuild
 * through `makePlan` instead.
 *
 * Invariants {@link makePlan} checks: the title, every workout label and
 * every exercise name are non-blank, and every exercise id is a slug (its own
 * {@link exerciseIdFromName}); there is at least one workout, each running at
 * least one exercise, with distinct labels; each key of `exercisesById` is the
 * {@link Exercise.id} of the entry it holds; every exercise a workout names is
 * planned; and every planned exercise is in range (see
 * {@link outOfRangeFieldsOf}). An exercise in more than one workout
 * (StrongLifts' squat) is planned once, shared.
 */
type Plan = {
  /** Human-friendly name, e.g. `"StrongLifts 5×5"`. */
  readonly title: string
  /** How each exercise is run, keyed by {@link Exercise.id}. */
  readonly exercisesById: Readonly<Record<string, PlannedExercise>>
  /** The workouts in cycle order; after the last comes the first again. */
  readonly workouts: Arr.NonEmptyReadonlyArray<Workout>
} & Brand.Brand<'Plan'>

/** The unvalidated parts of a plan, as {@link makePlan} takes them. */
interface PlanInput {
  /** Human-friendly name; must be non-blank. */
  readonly title: string
  /** One entry per exercise. */
  readonly exercises: readonly PlannedExercise[]
  /** The workouts in cycle order, each naming its exercises by id. */
  readonly workouts: readonly {
    readonly label: string
    readonly exerciseIds: readonly string[]
  }[]
}

/** A field of a {@link PlannedExercise} (or of its rule) that can be out of range. */
type PlannedExerciseField =
  | 'sets'
  | 'reps'
  | 'increment'
  | 'failuresBeforeDeload'
  | 'deloadFraction'
  | 'minimumLoad'
  | 'loadStep'

/** One reason {@link makePlan} refused a plan. */
type PlanProblem = Data.TaggedEnum<{
  /** The title is empty or only whitespace. */
  TitleEmpty: Record<never, never>
  /** There are no workouts. */
  WorkoutsMissing: Record<never, never>
  /** Workout `index` (0-based) has an empty or whitespace-only label. */
  WorkoutUnlabelled: { readonly index: number }
  /**
   * Exercise `index` (0-based) has an id that is empty or not a slug — not
   * what {@link exerciseIdFromName} makes of it.
   */
  ExerciseIdNotSlug: { readonly index: number }
  /** The exercise `exerciseId` has an empty or whitespace-only name. */
  ExerciseUnnamed: { readonly exerciseId: string }
  /** A workout runs no exercises. */
  WorkoutEmpty: { readonly label: string }
  /** Two workouts share a label. */
  WorkoutLabelDuplicate: { readonly label: string }
  /** The same exercise is planned twice. */
  ExerciseDuplicate: { readonly exerciseId: string }
  /** A planned exercise's field is out of its documented range. */
  ExerciseOutOfRange: { readonly exerciseId: string; readonly field: PlannedExerciseField }
  /** A workout names an exercise the plan does not run. */
  WorkoutExerciseUnplanned: { readonly label: string; readonly exerciseId: string }
}>

/** Constructors and matchers for {@link PlanProblem}. */
const PlanProblem = Data.taggedEnum<PlanProblem>()

/** The one {@link PlanProblem} variant a planned exercise read on its own can also report. */
type ExerciseOutOfRange = Data.TaggedEnum.Value<PlanProblem, 'ExerciseOutOfRange'>

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
 * The fields of a planned exercise that are out of range: `sets`, `reps` and
 * `failuresBeforeDeload` positive integers; `increment` and `loadStep` finite
 * and positive; `deloadFraction` strictly between 0 and 1; `minimumLoad`
 * finite and non-negative.
 *
 * @returns The out-of-range fields; empty when the exercise is valid
 */
const outOfRangeFieldsOf = (planned: PlannedExercise): readonly PlannedExerciseField[] => {
  const { progression } = planned
  const checks: readonly (readonly [PlannedExerciseField, boolean])[] = [
    ['sets', isPositiveInt(planned.sets)],
    ['reps', isPositiveInt(planned.reps)],
    ['increment', isPositive(progression.increment)],
    ['failuresBeforeDeload', isPositiveInt(progression.failuresBeforeDeload)],
    ['deloadFraction', progression.deloadFraction > 0 && progression.deloadFraction < 1],
    ['minimumLoad', isNonNegative(progression.minimumLoad)],
    ['loadStep', isPositive(progression.loadStep)],
  ]
  return checks.filter(([, valid]) => !valid).map(([field]) => field)
}

/** The problems with each planned exercise on its own — its id and name, its ranges — and with one planned twice. */
const exerciseProblemsOf = (exercises: readonly PlannedExercise[]): readonly PlanProblem[] => [
  ...exercises.flatMap((planned, index) => [
    ...(planned.exercise.id === '' ||
    exerciseIdFromName(planned.exercise.id) !== planned.exercise.id
      ? [PlanProblem.ExerciseIdNotSlug({ index })]
      : []),
    ...(isBlank(planned.exercise.name)
      ? [PlanProblem.ExerciseUnnamed({ exerciseId: planned.exercise.id })]
      : []),
  ]),
  ...exercises.flatMap((planned) =>
    outOfRangeFieldsOf(planned).map((field) =>
      PlanProblem.ExerciseOutOfRange({ exerciseId: planned.exercise.id, field })
    )
  ),
  ...pipe(
    exercises.map((planned) => planned.exercise.id),
    (ids) => ids.filter((id, index) => ids.indexOf(id) !== index),
    Arr.dedupe,
    Arr.map((exerciseId) => PlanProblem.ExerciseDuplicate({ exerciseId }))
  ),
]

/** The problems with the workouts beyond their emptiness: a blank label, a repeated label, an exercise not planned. */
const workoutProblemsOf = (
  workouts: PlanInput['workouts'],
  exercisesById: Readonly<Record<string, PlannedExercise>>
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
        .filter((exerciseId) => !Record.has(exercisesById, exerciseId))
        .map((exerciseId) =>
          PlanProblem.WorkoutExerciseUnplanned({ label: workout.label, exerciseId })
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
 * index: `makePlan` calls it after checking every invariant.
 *
 * @internal
 */
const brandPlan = Brand.nominal<Plan>()

/**
 * A {@link Plan} from its parts, when they satisfy every plan invariant.
 *
 * @param input - The title, one entry per exercise, and the workouts in cycle order
 * @returns The plan, with its exercises keyed by id; or {@link PlanInvalid}
 *   listing every {@link PlanProblem} found, not only the first
 */
const makePlan = (input: PlanInput): Either.Either<Plan, PlanInvalid> => {
  const exercisesById = Record.fromEntries(
    input.exercises.map((planned) => [planned.exercise.id, planned] as const)
  )
  const leadingProblems = [
    ...(isBlank(input.title) ? [PlanProblem.TitleEmpty()] : []),
    ...exerciseProblemsOf(input.exercises),
  ]
  const trailingProblems = workoutProblemsOf(input.workouts, exercisesById)
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
        onEmpty: () => Either.right(brandPlan({ title: input.title, exercisesById, workouts })),
      }),
  })
}

export {
  describeProblem,
  exerciseIdFromName,
  makePlan,
  outOfRangeFieldsOf,
  PlanInvalid,
  PlanProblem,
}
export type {
  Exercise,
  ExerciseOutOfRange,
  Load,
  LoadUnit,
  Plan,
  PlanInput,
  PlannedExercise,
  PlannedExerciseField,
  ProgressionRule,
  Workout,
}
