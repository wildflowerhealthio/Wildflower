import { Array as Arr, Either, Option, pipe, Schema } from 'effect'
import {
  exerciseIdFromName,
  type ExerciseGoal,
  type GoalField,
  makePlan,
  type Plan,
  type PlanInput,
  PlanProblem,
} from 'lifting-core'

/**
 * One exercise as the plan editor holds it: the text of every field, exactly
 * as typed, until a save decodes it.
 */
interface ExerciseDraft {
  /**
   * Identifies the row within the draft — the React key, and what a
   * {@link WorkoutDraft} lists. Stable across renames.
   */
  readonly key: string
  /**
   * The {@link Exercise.id} the exercise already has — from the plan being
   * edited, or the template the form was seeded from. Ids are persisted
   * (attempts are keyed by them), so an exercise keeps its id when renamed; a
   * new one (`None`) derives its id from its name on save.
   */
  readonly existingId: Option.Option<string>
  /** The display name. */
  readonly name: string
  /** The load in pounds. */
  readonly loadLb: string
  /** Sets per session. */
  readonly sets: string
  /** Reps per set. */
  readonly reps: string
  /** Pounds added after a successful session. */
  readonly incrementLb: string
  /** Consecutive failed sessions that trigger a deload. */
  readonly failuresBeforeDeload: string
  /** The share of the load a deload takes off, as a percentage (`10` for 10%). */
  readonly deloadPercent: string
  /** The lightest load a deload may reach, in pounds. */
  readonly minimumLoadLb: string
  /** The smallest change the equipment can make to the load, in pounds. */
  readonly loadStepLb: string
}

/** One workout as the plan editor holds it: its label and its exercises in order. */
interface WorkoutDraft {
  /** Identifies the row within the draft; the React key. */
  readonly key: string
  /** The workout's label, as typed. */
  readonly label: string
  /** The exercises it runs, in order, by {@link ExerciseDraft.key}. */
  readonly exerciseKeys: readonly string[]
}

/** A whole plan as the plan editor holds it, before a save decodes it into a `Plan`. */
interface PlanDraft {
  /** The plan's title, as typed. */
  readonly title: string
  /** The plan's exercises, in the order the editor lists them. */
  readonly exercises: readonly ExerciseDraft[]
  /** The workouts, in cycle order. */
  readonly workouts: readonly WorkoutDraft[]
}

/** The fields of an {@link ExerciseDraft} a problem can be reported against. */
type ExerciseField = Exclude<keyof ExerciseDraft, 'key' | 'existingId'>

/** The fields of a {@link WorkoutDraft} a problem can be reported against. */
type WorkoutField = 'label' | 'exerciseKeys'

/**
 * Where a problem sits in a draft, as a string key into
 * {@link PlanDraftProblems}: the title, one field of one exercise or workout
 * row, or the workout list as a whole.
 */
const DraftPath = {
  /** The plan's title. */
  title: 'title',
  /** The workout list as a whole (e.g. "add at least one workout"). */
  workouts: 'workouts',
  /** One field of the exercise row with this key. */
  exercise: (exerciseKey: string, field: ExerciseField): string =>
    `exercise/${exerciseKey}/${field}`,
  /** One field of the workout row with this key. */
  workout: (workoutKey: string, field: WorkoutField): string => `workout/${workoutKey}/${field}`,
} as const

/**
 * Every reason a draft is not yet a well-formed `Plan`, keyed by
 * {@link DraftPath}, each a sentence to show beside its field.
 */
type PlanDraftProblems = ReadonlyMap<string, string>

/**
 * The first of `base`, `base-2`, `base-3`, … not in `takenIds` — so a new
 * exercise whose name collides with another's id still gets an id of its own.
 * A blank `base` stays blank, for `makePlan` to refuse as `ExerciseIdNotSlug`.
 */
const unusedId = (base: string, takenIds: ReadonlySet<string>): string => {
  if (base === '') return base
  let candidate = base
  for (let suffix = 2; takenIds.has(candidate); suffix++) candidate = `${base}-${suffix}`
  return candidate
}

/**
 * A key of the form `prefix-N` not in `takenKeys`, for a new draft row.
 *
 * @param prefix - `"exercise"` or `"workout"`, so the two kinds never collide
 * @param takenKeys - The keys the draft already uses
 */
const freshDraftKey = (prefix: string, takenKeys: readonly string[]): string => {
  const taken = new Set(takenKeys)
  let index = takenKeys.length + 1
  while (taken.has(`${prefix}-${index}`)) index++
  return `${prefix}-${index}`
}

/**
 * A fraction as the percentage the editor shows (`0.1` → `"10"`), rounded to
 * 15 significant digits so float noise (`0.07 × 100 = 7.000000000000001`)
 * doesn't reach the field and the value divides back to the same fraction.
 */
const percentText = (fraction: number): string => String(Number((fraction * 100).toPrecision(15)))

/** An existing goal as an editor row, keyed by its exercise id. */
const exerciseDraftFromGoal = (goal: ExerciseGoal): ExerciseDraft => ({
  key: goal.exercise.id,
  existingId: Option.some(goal.exercise.id),
  name: goal.exercise.name,
  loadLb: String(goal.loadLb),
  sets: String(goal.sets),
  reps: String(goal.reps),
  incrementLb: String(goal.progression.incrementLb),
  failuresBeforeDeload: String(goal.progression.failuresBeforeDeload),
  deloadPercent: percentText(goal.progression.deloadFraction),
  minimumLoadLb: String(goal.progression.minimumLoadLb),
  loadStepLb: String(goal.progression.loadStepLb),
})

/**
 * A plan as an editable draft: every number as its text, every exercise keyed
 * by its id so workouts can refer to it.
 *
 * @param plan - The plan to edit
 * @returns A draft that {@link planFromDraft} decodes back to `plan`
 */
const draftFromPlan = (plan: Plan): PlanDraft => ({
  title: plan.title,
  exercises: Object.values(plan.goalsByExerciseId).map(exerciseDraftFromGoal),
  workouts: plan.workouts.map((workout, index) => ({
    key: `workout-${index + 1}`,
    label: workout.label,
    exerciseKeys: workout.exerciseIds,
  })),
})

/**
 * An empty exercise row: 5×5, +5 lb per success, and a 10% deload after three
 * failures in 5 lb steps down to no floor — StrongLifts' rule without its bar.
 */
const blankExerciseDraft = (key: string): ExerciseDraft => ({
  key,
  existingId: Option.none(),
  name: '',
  loadLb: '',
  sets: '5',
  reps: '5',
  incrementLb: '5',
  failuresBeforeDeload: '3',
  deloadPercent: '10',
  minimumLoadLb: '0',
  loadStepLb: '5',
})

/** A draft with no exercises and one empty workout — where "new plan" starts. */
const emptyPlanDraft: PlanDraft = {
  title: '',
  exercises: [],
  workouts: [{ key: 'workout-1', label: 'A', exerciseKeys: [] }],
}

/** The draft with the exercise row `exerciseKey` changed by `patch`. */
const editExercise = (
  draft: PlanDraft,
  exerciseKey: string,
  patch: Partial<Pick<ExerciseDraft, ExerciseField>>
): PlanDraft => ({
  ...draft,
  exercises: draft.exercises.map((exerciseDraft) =>
    exerciseDraft.key === exerciseKey ? { ...exerciseDraft, ...patch } : exerciseDraft
  ),
})

/** The draft with a blank exercise row appended. */
const addExercise = (draft: PlanDraft): PlanDraft => ({
  ...draft,
  exercises: [
    ...draft.exercises,
    blankExerciseDraft(
      freshDraftKey(
        'exercise',
        draft.exercises.map((exerciseDraft) => exerciseDraft.key)
      )
    ),
  ],
})

/** The draft without the exercise row `exerciseKey`, which also leaves every workout. */
const removeExercise = (draft: PlanDraft, exerciseKey: string): PlanDraft => ({
  ...draft,
  exercises: draft.exercises.filter((exerciseDraft) => exerciseDraft.key !== exerciseKey),
  workouts: draft.workouts.map((workoutDraft) => ({
    ...workoutDraft,
    exerciseKeys: workoutDraft.exerciseKeys.filter((key) => key !== exerciseKey),
  })),
})

/** The draft with the workout row `workoutKey` changed by `edit`. */
const editWorkout = (
  draft: PlanDraft,
  workoutKey: string,
  edit: (workoutDraft: WorkoutDraft) => WorkoutDraft
): PlanDraft => ({
  ...draft,
  workouts: draft.workouts.map((workoutDraft) =>
    workoutDraft.key === workoutKey ? edit(workoutDraft) : workoutDraft
  ),
})

/** The draft with an empty workout appended, labelled with the next free letter. */
const addWorkout = (draft: PlanDraft): PlanDraft => {
  const takenLabels = new Set(draft.workouts.map((workoutDraft) => workoutDraft.label.trim()))
  const label = pipe(
    Arr.findFirst('ABCDEFGHIJKLMNOPQRSTUVWXYZ', (letter) => !takenLabels.has(letter)),
    Option.getOrElse(() => '')
  )
  return {
    ...draft,
    workouts: [
      ...draft.workouts,
      {
        key: freshDraftKey(
          'workout',
          draft.workouts.map((workoutDraft) => workoutDraft.key)
        ),
        label,
        exerciseKeys: [],
      },
    ],
  }
}

/** The draft without the workout row `workoutKey`. */
const removeWorkout = (draft: PlanDraft, workoutKey: string): PlanDraft => ({
  ...draft,
  workouts: draft.workouts.filter((workoutDraft) => workoutDraft.key !== workoutKey),
})

/**
 * The workout with the exercise at `index` swapped with its neighbour `offset`
 * away (`-1` earlier, `1` later); unchanged when that neighbour doesn't exist.
 */
const moveWorkoutExercise =
  (index: number, offset: -1 | 1) =>
  (workoutDraft: WorkoutDraft): WorkoutDraft =>
    pipe(
      Option.all([
        Arr.get(workoutDraft.exerciseKeys, index),
        Arr.get(workoutDraft.exerciseKeys, index + offset),
      ]),
      Option.match({
        onNone: () => workoutDraft,
        onSome: ([movingKey, neighbourKey]) => ({
          ...workoutDraft,
          exerciseKeys: pipe(
            workoutDraft.exerciseKeys,
            Arr.replace(index, neighbourKey),
            Arr.replace(index + offset, movingKey)
          ),
        }),
      })
    )

/**
 * A field's text as the number it spells, or `NaN` when it spells none
 * (blank, or not a number).
 *
 * @remarks
 * `NaN` is out of every range `makePlan` checks, so text that is not a number
 * comes back as that field's `GoalOutOfRange` problem — the range rules stay
 * in `lifting-core` alone rather than being restated here.
 */
const numberFromText = (text: string): number =>
  Either.getOrElse(Schema.decodeEither(Schema.NumberFromString)(text), () => Number.NaN)

/** The sentence a person reads for each out-of-range goal field. */
const goalFieldMessages: { readonly [Field in GoalField]: string } = {
  loadLb: 'Enter a load of at least the minimum load',
  sets: 'Enter a whole number above 0',
  reps: 'Enter a whole number above 0',
  incrementLb: 'Enter a number of pounds above 0',
  failuresBeforeDeload: 'Enter a whole number above 0',
  deloadFraction: 'Enter a percentage above 0 and below 100',
  minimumLoadLb: 'Enter a number of pounds, 0 or more',
  loadStepLb: 'Enter a number of pounds above 0',
}

/** The draft field each goal field is edited in. */
const draftFieldOf = (field: GoalField): ExerciseField =>
  field === 'deloadFraction' ? 'deloadPercent' : field

/** The keys of the rows whose `value` is `wanted`, for a problem that names a value. */
const keysWhere = <Row extends { readonly key: string }>(
  rows: readonly Row[],
  value: (row: Row) => string,
  wanted: string
): readonly string[] => rows.filter((row) => value(row) === wanted).map((row) => row.key)

/**
 * Decodes a draft into a well-formed `Plan` through `lifting-core`'s
 * `makePlan`, or lists every problem in it.
 *
 * @param draft - The editor's current draft
 * @returns `Right` with the plan, or `Left` with every problem, keyed by
 *   {@link DraftPath}
 *
 * @remarks
 * The draft is only parsed here: names, labels and the title are trimmed,
 * each number read from its text, and a new exercise's id derived from its
 * name by `lifting-core`'s `exerciseIdFromName` (suffixed `-2`, `-3`, … past
 * any id already taken; an existing exercise keeps its id). Whether the
 * result is a plan — every range, every blank, distinct labels, non-empty
 * workouts — is `makePlan`'s call alone, and each `PlanProblem` it returns is
 * placed under the field it names.
 */
const planFromDraft = (draft: PlanDraft): Either.Either<Plan, PlanDraftProblems> => {
  const problems = new Map<string, string>()
  const setProblem = (path: string, message: string): void => {
    if (!problems.has(path)) problems.set(path, message)
  }
  const exerciseNameAt = (key: string): string =>
    draft.exercises.find((exerciseDraft) => exerciseDraft.key === key)?.name.trim() ?? ''

  const takenIds = new Set(
    Arr.filterMap(draft.exercises, (exerciseDraft) => exerciseDraft.existingId)
  )
  const idsByKey = new Map<string, string>()
  const goals = draft.exercises.map((exerciseDraft): ExerciseGoal => {
    const name = exerciseDraft.name.trim()
    const id = Option.getOrElse(exerciseDraft.existingId, () =>
      unusedId(exerciseIdFromName(name), takenIds)
    )
    takenIds.add(id)
    idsByKey.set(exerciseDraft.key, id)
    return {
      exercise: { id, name },
      loadLb: numberFromText(exerciseDraft.loadLb),
      sets: numberFromText(exerciseDraft.sets),
      reps: numberFromText(exerciseDraft.reps),
      progression: {
        incrementLb: numberFromText(exerciseDraft.incrementLb),
        failuresBeforeDeload: numberFromText(exerciseDraft.failuresBeforeDeload),
        deloadFraction: numberFromText(exerciseDraft.deloadPercent) / 100,
        minimumLoadLb: numberFromText(exerciseDraft.minimumLoadLb),
        loadStepLb: numberFromText(exerciseDraft.loadStepLb),
      },
    }
  })

  const workouts = draft.workouts.map((workoutDraft) => {
    return {
      label: workoutDraft.label.trim(),
      exerciseIds: Arr.filterMap(workoutDraft.exerciseKeys, (exerciseKey) =>
        Option.fromNullable(idsByKey.get(exerciseKey))
      ),
    }
  })
  const input: PlanInput = { title: draft.title.trim(), goals, workouts }

  const exerciseKeysWithId = (exerciseId: string): readonly string[] =>
    keysWhere(draft.exercises, (exerciseDraft) => idsByKey.get(exerciseDraft.key) ?? '', exerciseId)
  const workoutKeysLabelled = (label: string): readonly string[] =>
    keysWhere(draft.workouts, (workoutDraft) => workoutDraft.label.trim(), label)
  const placeProblem = PlanProblem.$match({
    TitleEmpty: () => {
      setProblem(DraftPath.title, 'Give the plan a title')
    },
    WorkoutsMissing: () => {
      setProblem(DraftPath.workouts, 'Add at least one workout')
    },
    WorkoutUnlabelled: ({ index }) => {
      for (const workoutDraft of Arr.get(draft.workouts, index).pipe(Option.toArray))
        setProblem(DraftPath.workout(workoutDraft.key, 'label'), 'Label the workout')
    },
    ExerciseIdNotSlug: ({ index }) => {
      for (const exerciseDraft of Arr.get(draft.exercises, index).pipe(Option.toArray))
        setProblem(
          DraftPath.exercise(exerciseDraft.key, 'name'),
          exerciseNameAt(exerciseDraft.key) === ''
            ? 'Name the exercise'
            : 'Use letters, digits and hyphens'
        )
    },
    ExerciseUnnamed: ({ exerciseId }) => {
      for (const key of exerciseKeysWithId(exerciseId))
        setProblem(DraftPath.exercise(key, 'name'), 'Name the exercise')
    },
    WorkoutEmpty: ({ label }) => {
      for (const key of workoutKeysLabelled(label))
        setProblem(
          DraftPath.workout(key, 'exerciseKeys'),
          'Add at least one exercise to this workout'
        )
    },
    WorkoutLabelDuplicate: ({ label }) => {
      for (const key of workoutKeysLabelled(label).slice(1))
        setProblem(DraftPath.workout(key, 'label'), 'Another workout already has this label')
    },
    GoalDuplicate: ({ exerciseId }) => {
      for (const key of exerciseKeysWithId(exerciseId).slice(1))
        setProblem(DraftPath.exercise(key, 'name'), 'Another exercise already has this id')
    },
    GoalOutOfRange: ({ exerciseId, field }) => {
      for (const key of exerciseKeysWithId(exerciseId))
        setProblem(DraftPath.exercise(key, draftFieldOf(field)), goalFieldMessages[field])
    },
    WorkoutExerciseWithoutGoal: ({ label }) => {
      for (const key of workoutKeysLabelled(label))
        setProblem(
          DraftPath.workout(key, 'exerciseKeys'),
          'This workout names an exercise the plan does not have'
        )
    },
  })

  return Either.mapLeft(makePlan(input), (planInvalid): PlanDraftProblems => {
    for (const problem of planInvalid.problems) placeProblem(problem)
    return problems
  })
}

export {
  addExercise,
  addWorkout,
  blankExerciseDraft,
  DraftPath,
  draftFromPlan,
  editExercise,
  editWorkout,
  emptyPlanDraft,
  freshDraftKey,
  moveWorkoutExercise,
  planFromDraft,
  removeExercise,
  removeWorkout,
}
export type { ExerciseDraft, ExerciseField, PlanDraft, PlanDraftProblems, WorkoutDraft }
