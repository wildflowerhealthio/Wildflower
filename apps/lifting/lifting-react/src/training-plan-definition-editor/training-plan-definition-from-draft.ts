import { Array as Arr, Either, Option, type ParseResult, pipe } from 'effect'
import { ExerciseConcept, TrainingPlanDefinition } from 'lifting-core-js'

import { enteredNumber } from '../form/entered-number.ts'
import { type ParseIssue, parseIssuesOf } from '../form/parse-issues.ts'
import { DraftPath, type DraftProblems } from './draft-problems.ts'
import type {
  DayDraft,
  ExerciseDraft,
  ExerciseTextField,
  TrainingPlanDefinitionDraft,
} from './training-plan-definition-draft.ts'

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
 * `lifting-core-js` makes one: its `ExerciseConcept` and progression rule, then
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
 * `planDefinitionId`, level by level as `lifting-core-js` makes one — each
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

export { trainingPlanDefinitionFromDraft }
