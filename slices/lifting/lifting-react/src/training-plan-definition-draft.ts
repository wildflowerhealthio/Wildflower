import { Array as Arr, Either, Option, type ParseResult, pipe } from 'effect'
import { ExerciseConcept, type Load, TrainingPlanDefinition } from 'lifting-core'

import { enteredNumber, numberText } from './entered-number.ts'
import { type ParseIssue, parseIssuesOf } from './parse-issues.ts'

/**
 * One exercise (definition) of a day as the editor holds it: the text of
 * every field exactly as typed, and the unit chosen, until a save makes it.
 */
interface ExerciseDraft {
  /** Identifies the row within the whole draft; the React key. Stable across edits. */
  readonly key: string
  /**
   * The exercise id the row already has — from the training plan definition
   * being edited or the template it was seeded from. Ids are persisted
   * (`ExerciseRequest`s and sets are keyed by them), so an exercise keeps its
   * id when renamed; a new row (`None`) takes its id from its name
   * (`ExerciseConcept.idFromName`), so two rows named alike are one exercise.
   */
  readonly existingExerciseId: Option.Option<string>
  /** The exercise's display name. */
  readonly name: string
  /** Sets each workout. */
  readonly sets: string
  /** Reps per set. */
  readonly reps: string
  /** The unit the progression rule's amounts — and the exercise's loads — are in. */
  readonly unit: Load.Unit
  /** Added to the load after a met workout. */
  readonly increment: string
  /** Failed workouts in a row at one load that trigger a deload. */
  readonly failuresBeforeDeload: string
  /** The fraction of the load a deload takes off. */
  readonly deloadFraction: string
  /** The lightest load a deload may reach. */
  readonly minimumLoad: string
  /** The smallest change the equipment can make to the load. */
  readonly loadStep: string
}

/** The text fields of an {@link ExerciseDraft}, each a field a problem can sit under. */
type ExerciseTextField = Exclude<keyof ExerciseDraft, 'key' | 'existingExerciseId' | 'unit'>

/** One day as the editor holds it: its label as typed and its exercises in order. */
interface DayDraft {
  /** Identifies the row within the draft; the React key. */
  readonly key: string
  /** The day's label, as typed. */
  readonly label: string
  /** The day's exercise rows, in order. */
  readonly exercises: readonly ExerciseDraft[]
}

/** A whole training plan definition as the editor holds it, before a save makes it. */
interface TrainingPlanDefinitionDraft {
  /** The title, as typed. */
  readonly title: string
  /** The days, in cycle order. */
  readonly days: readonly DayDraft[]
}

/**
 * Where a problem sits in a draft, as a key into {@link DraftProblems}: the
 * title, the day list as a whole, a day's label or exercise list, one field
 * of an exercise row, or an exercise row as a whole.
 */
const DraftPath = {
  title: 'title',
  /** The day list as a whole ("add at least one day"). */
  days: 'days',
  dayLabel: (dayKey: string): string => `day/${dayKey}/label`,
  /** A day's exercise list as a whole ("add at least one exercise"). */
  dayExercises: (dayKey: string): string => `day/${dayKey}/exercises`,
  exerciseField: (exerciseKey: string, field: ExerciseTextField): string =>
    `exercise/${exerciseKey}/${field}`,
  /** An exercise row as a whole (one exercise defined two ways). */
  exercise: (exerciseKey: string): string => `exercise/${exerciseKey}`,
} as const

/**
 * Every reason a draft is not yet a training plan definition, keyed by
 * {@link DraftPath}, each a sentence to show under its field — the first
 * found for each.
 */
type DraftProblems = ReadonlyMap<string, string>

/** A problem found at a {@link DraftPath}. */
type DraftProblem = readonly [draftPath: string, message: string]

/**
 * The field each `extension` index of a rule
 * `TrainingPlanDefinition.ProgressionRule.make` refuses is edited in: `make`
 * writes one sub-extension per `ProgressionRule.Part`, in that order, and
 * every part but the unit (a choice, never refused) is a field of the same
 * name.
 */
const progressionRuleFieldAt = (index: PropertyKey | undefined): Option.Option<ExerciseTextField> =>
  pipe(
    typeof index === 'number'
      ? Arr.get(Object.values(TrainingPlanDefinition.ProgressionRule.Part), index)
      : Option.none(),
    Option.filter(
      (part): part is Exclude<TrainingPlanDefinition.ProgressionRule.PartName, 'unit'> =>
        part !== TrainingPlanDefinition.ProgressionRule.Part.Unit
    )
  )

/**
 * The field each `code` index of an exercise (definition)
 * `TrainingPlanDefinition.Exercise.make` refuses is edited in: `make` writes
 * the exercise concept, then the `sets`, then the `reps` exercise parameter.
 */
const exerciseFieldAt = (index: PropertyKey | undefined): Option.Option<ExerciseTextField> =>
  typeof index === 'number' ? Arr.get(['name', 'sets', 'reps'] as const, index) : Option.none()

/** The problems of a refused make, each under the draft path its issue's path maps to. */
const draftProblemsOf = (
  parseError: ParseResult.ParseError,
  draftPathOf: (path: ParseIssue['path']) => string
): readonly DraftProblem[] =>
  parseIssuesOf(parseError).map(({ path, message }) => [draftPathOf(path), message])

/** A draft's problems, the first found at each path kept. */
const toDraftProblems = (problems: readonly DraftProblem[]): DraftProblems => {
  const byPath = new Map<string, string>()
  for (const [draftPath, message] of problems)
    if (!byPath.has(draftPath)) byPath.set(draftPath, message)
  return byPath
}

/** A value made, or the problems that stopped it. */
type Made<A> = Either.Either<A, readonly DraftProblem[]>

/** The problems of every one of `made` that was refused. */
const problemsOf = (made: readonly Made<unknown>[]): readonly DraftProblem[] =>
  made.flatMap((each) => Either.match(each, { onLeft: (problems) => problems, onRight: () => [] }))

/**
 * `fields` made together, as `Either.all` makes them — or, where that stops
 * at the first refusal, every problem of every field refused.
 */
const madeTogether = <A>({
  allFields,
  fields,
}: {
  /** `Either.all` of `fields`. */
  readonly allFields: Made<A>
  readonly fields: Readonly<Record<string, Made<unknown>>>
}): Made<A> => Either.mapLeft(allFields, () => problemsOf(Object.values(fields)))

/** A numeric field's text as its number, or its problem under the field. */
const numberAt = ({
  exerciseDraft,
  field,
}: {
  readonly exerciseDraft: ExerciseDraft
  readonly field: Exclude<ExerciseTextField, 'name'>
}): Made<number> =>
  Either.mapLeft(enteredNumber(exerciseDraft[field]), (message): readonly DraftProblem[] => [
    [DraftPath.exerciseField(exerciseDraft.key, field), message],
  ])

/** The exercise id a row has, or takes from its name. */
const exerciseIdOf = (exerciseDraft: ExerciseDraft): string =>
  Option.getOrElse(exerciseDraft.existingExerciseId, () =>
    ExerciseConcept.idFromName(exerciseDraft.name.trim())
  )

/** A row's exercise, made by `ExerciseConcept.make`; every problem sits under its name. */
const exerciseConceptFromDraft = (exerciseDraft: ExerciseDraft): Made<ExerciseConcept.Type> => {
  const namePath = DraftPath.exerciseField(exerciseDraft.key, 'name')
  const name = exerciseDraft.name.trim()
  return name === ''
    ? Either.left([[namePath, 'Name the exercise']])
    : Either.mapLeft(
        ExerciseConcept.make({ id: exerciseIdOf(exerciseDraft), name }),
        (parseError) => draftProblemsOf(parseError, () => namePath)
      )
}

/** A row's progression rule, made by `TrainingPlanDefinition.ProgressionRule.make`. */
const progressionRuleFromDraft = (
  exerciseDraft: ExerciseDraft
): Made<TrainingPlanDefinition.ProgressionRule.Type> => {
  const fields = {
    increment: numberAt({ exerciseDraft, field: 'increment' }),
    failuresBeforeDeload: numberAt({ exerciseDraft, field: 'failuresBeforeDeload' }),
    deloadFraction: numberAt({ exerciseDraft, field: 'deloadFraction' }),
    minimumLoad: numberAt({ exerciseDraft, field: 'minimumLoad' }),
    loadStep: numberAt({ exerciseDraft, field: 'loadStep' }),
  }
  return Either.flatMap(
    madeTogether({ allFields: Either.all(fields), fields }),
    (progressionRuleParameters) =>
      Either.mapLeft(
        TrainingPlanDefinition.ProgressionRule.make({
          unit: exerciseDraft.unit,
          ...progressionRuleParameters,
        }),
        (parseError) =>
          draftProblemsOf(parseError, (path) =>
            Option.match(progressionRuleFieldAt(path[1]), {
              onNone: () => DraftPath.exercise(exerciseDraft.key),
              onSome: (field) => DraftPath.exerciseField(exerciseDraft.key, field),
            })
          )
      )
  )
}

/**
 * An exercise row made into an exercise (definition), level by level as
 * `lifting-core` makes one: its `ExerciseConcept` and progression rule, then
 * the exercise (definition) of them with its sets and reps.
 */
const exerciseFromDraft = (
  exerciseDraft: ExerciseDraft
): Made<TrainingPlanDefinition.Exercise.Type> => {
  const fields = {
    exerciseConcept: exerciseConceptFromDraft(exerciseDraft),
    progressionRule: progressionRuleFromDraft(exerciseDraft),
    sets: numberAt({ exerciseDraft, field: 'sets' }),
    reps: numberAt({ exerciseDraft, field: 'reps' }),
  }
  return Either.flatMap(
    madeTogether({ allFields: Either.all(fields), fields }),
    (trainingPlanDefinitionExercise) =>
      Either.mapLeft(
        TrainingPlanDefinition.Exercise.make(trainingPlanDefinitionExercise),
        (parseError) =>
          draftProblemsOf(parseError, (path) =>
            Option.match(exerciseFieldAt(path[1]), {
              onNone: () => DraftPath.exercise(exerciseDraft.key),
              onSome: (field) => DraftPath.exerciseField(exerciseDraft.key, field),
            })
          )
      )
  )
}

/** The sentence for a day with no exercise, in place of the schema's "is missing". */
const NO_EXERCISE = 'Add at least one exercise to this day'

/** The sentence for a training plan definition with no day, in place of the schema's "is missing". */
const NO_DAY = 'Add at least one day'

/**
 * A day made by `TrainingPlanDefinition.Day.make` from its label and its
 * rows' exercises (definitions); every row's problems too.
 *
 * @remarks
 * The day is made from the rows that were made even when others were not, so
 * a problem with its label shows at once; its "no exercise" problem counts
 * only when it has no rows at all.
 */
const dayFromDraft = (dayDraft: DayDraft): Made<TrainingPlanDefinition.Day.Type> => {
  const rows = dayDraft.exercises.map(exerciseFromDraft)
  const rowProblems = problemsOf(rows)
  const day = Either.mapLeft(
    TrainingPlanDefinition.Day.make({
      label: dayDraft.label.trim(),
      trainingPlanDefinitionExercises: Arr.getRights(rows),
    }),
    (parseError) =>
      parseIssuesOf(parseError).flatMap(({ path, message }): readonly DraftProblem[] => {
        if (path[0] === 'title') return [[DraftPath.dayLabel(dayDraft.key), message]]
        return dayDraft.exercises.length === 0
          ? [[DraftPath.dayExercises(dayDraft.key), NO_EXERCISE]]
          : []
      })
  )
  return Arr.isNonEmptyReadonlyArray(rowProblems)
    ? Either.left([...rowProblems, ...problemsOf([day])])
    : day
}

/**
 * A draft made into a training plan definition stored under
 * `planDefinitionId`, level by level as `lifting-core` makes one — each
 * exercise row, each day, then the training plan definition of them — or
 * every problem found, each under the field its make's issue path names.
 *
 * @remarks
 * The draft is only parsed here: the title, labels and names are trimmed, a
 * number read from each numeric field's text, and a new row's exercise id
 * taken from its name — a blank name and text that spells no number are the
 * only problems judged here.
 * Whether that makes a training plan definition — every range, two days with
 * one label, one exercise defined two ways — is the `make`s' call alone.
 * The training plan definition is made from the days that were made even
 * when others were not, so its own problems show alongside theirs; a check
 * across days runs only once the title is accepted, as its schema runs it.
 */
const trainingPlanDefinitionFromDraft = ({
  draft,
  planDefinitionId,
}: {
  readonly draft: TrainingPlanDefinitionDraft
  readonly planDefinitionId: string
}): Either.Either<TrainingPlanDefinition.Type, DraftProblems> => {
  const days = draft.days.map((dayDraft) => ({ dayDraft, day: dayFromDraft(dayDraft) }))
  const madeDays = Arr.filterMap(days, ({ dayDraft, day }) =>
    Either.getRight(Either.map(day, (made) => ({ dayDraft, day: made })))
  )
  const dayProblems = problemsOf(days.map(({ day }) => day))
  const draftPathAt = (path: ParseIssue['path']): Option.Option<string> => {
    if (path[0] === 'title') return Option.some(DraftPath.title)
    const [, dayIndex, dayField, exerciseIndex] = path
    return pipe(
      typeof dayIndex === 'number' ? Arr.get(madeDays, dayIndex) : Option.none(),
      Option.flatMap(({ dayDraft }) => {
        if (dayField === 'title') return Option.some(DraftPath.dayLabel(dayDraft.key))
        return pipe(
          typeof exerciseIndex === 'number'
            ? Arr.get(dayDraft.exercises, exerciseIndex)
            : Option.none(),
          Option.map((exerciseDraft) => DraftPath.exercise(exerciseDraft.key))
        )
      }),
      // Anything else under `action` is the day list itself: no day.
      Option.orElse(() => (draft.days.length === 0 ? Option.some(DraftPath.days) : Option.none()))
    )
  }
  const trainingPlanDefinition = Either.mapLeft(
    TrainingPlanDefinition.make({
      planDefinitionId,
      title: draft.title.trim(),
      trainingPlanDefinitionDays: madeDays.map(({ day }) => day),
    }),
    (parseError) =>
      parseIssuesOf(parseError).flatMap(({ path, message }): readonly DraftProblem[] =>
        Option.match(draftPathAt(path), {
          onNone: () => [],
          onSome: (draftPath) => [[draftPath, draftPath === DraftPath.days ? NO_DAY : message]],
        })
      )
  )
  const problems = [...dayProblems, ...problemsOf([trainingPlanDefinition])]
  return Arr.isNonEmptyReadonlyArray(problems)
    ? Either.left(toDraftProblems(problems))
    : Either.mapLeft(trainingPlanDefinition, toDraftProblems)
}

/** An exercise (definition) as an editor row under `key`, keeping its exercise id. */
const exerciseDraftOf = ({
  key,
  trainingPlanDefinitionExercise,
}: {
  readonly key: string
  readonly trainingPlanDefinitionExercise: TrainingPlanDefinition.Exercise.Type
}): ExerciseDraft => {
  const progressionRule = TrainingPlanDefinition.Exercise.progressionRuleOf(
    trainingPlanDefinitionExercise
  )
  const { ProgressionRule } = TrainingPlanDefinition
  return {
    key,
    existingExerciseId: Option.some(
      TrainingPlanDefinition.Exercise.exerciseIdOf(trainingPlanDefinitionExercise)
    ),
    name: ExerciseConcept.nameOf(
      TrainingPlanDefinition.Exercise.exerciseConceptOf(trainingPlanDefinitionExercise)
    ),
    sets: numberText(TrainingPlanDefinition.Exercise.setsOf(trainingPlanDefinitionExercise)),
    reps: numberText(TrainingPlanDefinition.Exercise.repsOf(trainingPlanDefinitionExercise)),
    unit: ProgressionRule.unitOf(progressionRule),
    increment: numberText(ProgressionRule.incrementOf(progressionRule)),
    failuresBeforeDeload: numberText(ProgressionRule.failuresBeforeDeloadOf(progressionRule)),
    deloadFraction: numberText(ProgressionRule.deloadFractionOf(progressionRule)),
    minimumLoad: numberText(ProgressionRule.minimumLoadOf(progressionRule)),
    loadStep: numberText(ProgressionRule.loadStepOf(progressionRule)),
  }
}

/**
 * A training plan definition as an editable draft: every number as its text,
 * every row keyed and every exercise keeping its id.
 *
 * @returns A draft {@link trainingPlanDefinitionFromDraft} makes back into
 *   `trainingPlanDefinition` under its id
 */
const draftFromTrainingPlanDefinition = (
  trainingPlanDefinition: TrainingPlanDefinition.Type
): TrainingPlanDefinitionDraft => ({
  title: trainingPlanDefinition.title,
  days: TrainingPlanDefinition.daysOf(trainingPlanDefinition).map((day, dayIndex) => ({
    key: `day-${dayIndex + 1}`,
    label: TrainingPlanDefinition.Day.labelOf(day),
    exercises: TrainingPlanDefinition.Day.exercisesOf(day).map(
      (trainingPlanDefinitionExercise, exerciseIndex) =>
        exerciseDraftOf({
          key: `exercise-${dayIndex + 1}-${exerciseIndex + 1}`,
          trainingPlanDefinitionExercise,
        })
    ),
  })),
})

/**
 * A key of the form `prefix-N` none of `takenKeys` is, for a new row.
 *
 * @param prefix - `"exercise"` or `"day"`, so the two kinds never collide
 */
const freshDraftKey = ({
  prefix,
  takenKeys,
}: {
  readonly prefix: string
  readonly takenKeys: readonly string[]
}): string => {
  const taken = new Set(takenKeys)
  let index = takenKeys.length + 1
  while (taken.has(`${prefix}-${index}`)) index++
  return `${prefix}-${index}`
}

/** Every exercise row's key, across every day. */
const exerciseKeysOf = (draft: TrainingPlanDefinitionDraft): readonly string[] =>
  draft.days.flatMap((dayDraft) => dayDraft.exercises.map((exerciseDraft) => exerciseDraft.key))

/**
 * A blank exercise row: 5×5 in pounds, +5 lb per success, and a 10% deload
 * after three failures in 5 lb steps down to the 45 lb bar — StrongLifts'
 * barbell rule.
 */
const blankExerciseDraft = (key: string): ExerciseDraft => ({
  key,
  existingExerciseId: Option.none(),
  name: '',
  sets: '5',
  reps: '5',
  unit: '[lb_av]',
  increment: '5',
  failuresBeforeDeload: '3',
  deloadFraction: '0.1',
  minimumLoad: '45',
  loadStep: '5',
})

/** A draft with no title and one day `A` with no exercise — where a new training plan definition starts. */
const emptyDraft: TrainingPlanDefinitionDraft = {
  title: '',
  days: [{ key: 'day-1', label: 'A', exercises: [] }],
}

/** The draft with the day `dayKey` changed by `edit`. */
const editDay = ({
  draft,
  dayKey,
  edit,
}: {
  readonly draft: TrainingPlanDefinitionDraft
  readonly dayKey: string
  readonly edit: (dayDraft: DayDraft) => DayDraft
}): TrainingPlanDefinitionDraft => ({
  ...draft,
  days: draft.days.map((dayDraft) => (dayDraft.key === dayKey ? edit(dayDraft) : dayDraft)),
})

/** The draft with a day appended, labelled with the first letter no day has. */
const addDay = (draft: TrainingPlanDefinitionDraft): TrainingPlanDefinitionDraft => {
  const takenLabels = new Set(draft.days.map((dayDraft) => dayDraft.label.trim()))
  return {
    ...draft,
    days: [
      ...draft.days,
      {
        key: freshDraftKey({
          prefix: 'day',
          takenKeys: draft.days.map((dayDraft) => dayDraft.key),
        }),
        label: Option.getOrElse(
          Arr.findFirst('ABCDEFGHIJKLMNOPQRSTUVWXYZ', (letter) => !takenLabels.has(letter)),
          () => ''
        ),
        exercises: [],
      },
    ],
  }
}

/** The draft without the day `dayKey`. */
const removeDay = ({
  draft,
  dayKey,
}: {
  readonly draft: TrainingPlanDefinitionDraft
  readonly dayKey: string
}): TrainingPlanDefinitionDraft => ({
  ...draft,
  days: draft.days.filter((dayDraft) => dayDraft.key !== dayKey),
})

/** The draft with a blank exercise row appended to the day `dayKey`. */
const addExercise = ({
  draft,
  dayKey,
}: {
  readonly draft: TrainingPlanDefinitionDraft
  readonly dayKey: string
}): TrainingPlanDefinitionDraft => {
  const key = freshDraftKey({ prefix: 'exercise', takenKeys: exerciseKeysOf(draft) })
  return editDay({
    draft,
    dayKey,
    edit: (dayDraft) => ({
      ...dayDraft,
      exercises: [...dayDraft.exercises, blankExerciseDraft(key)],
    }),
  })
}

/** The day with the exercise row `exerciseKey` changed by `patch`. */
const editExercise = ({
  dayDraft,
  exerciseKey,
  patch,
}: {
  readonly dayDraft: DayDraft
  readonly exerciseKey: string
  readonly patch: Partial<Pick<ExerciseDraft, ExerciseTextField | 'unit'>>
}): DayDraft => ({
  ...dayDraft,
  exercises: dayDraft.exercises.map((exerciseDraft) =>
    exerciseDraft.key === exerciseKey ? { ...exerciseDraft, ...patch } : exerciseDraft
  ),
})

/** The day without the exercise row `exerciseKey`. */
const removeExercise = ({
  dayDraft,
  exerciseKey,
}: {
  readonly dayDraft: DayDraft
  readonly exerciseKey: string
}): DayDraft => ({
  ...dayDraft,
  exercises: dayDraft.exercises.filter((exerciseDraft) => exerciseDraft.key !== exerciseKey),
})

/**
 * The day with the exercise row at `index` swapped with its neighbour
 * `offset` away (`-1` earlier, `1` later); unchanged when there is none.
 */
const moveExercise = ({
  dayDraft,
  index,
  offset,
}: {
  readonly dayDraft: DayDraft
  readonly index: number
  readonly offset: -1 | 1
}): DayDraft =>
  pipe(
    Option.all([Arr.get(dayDraft.exercises, index), Arr.get(dayDraft.exercises, index + offset)]),
    Option.match({
      onNone: () => dayDraft,
      onSome: ([moving, neighbour]) => ({
        ...dayDraft,
        exercises: pipe(
          dayDraft.exercises,
          Arr.replace(index, neighbour),
          Arr.replace(index + offset, moving)
        ),
      }),
    })
  )

export {
  addDay,
  addExercise,
  DraftPath,
  draftFromTrainingPlanDefinition,
  editDay,
  editExercise,
  emptyDraft,
  moveExercise,
  removeDay,
  removeExercise,
  trainingPlanDefinitionFromDraft,
}
export type {
  DayDraft,
  DraftProblems,
  ExerciseDraft,
  ExerciseTextField,
  TrainingPlanDefinitionDraft,
}
