import { Array as Arr, Option } from 'effect'
import { ExerciseConcept, type Load, TrainingPlanDefinition } from 'lifting-core'

import { numberText } from '../form/entered-number.ts'

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
 * @returns A draft `trainingPlanDefinitionFromDraft` makes back into
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

/** The day "Add day" appends: no exercise yet, labelled with the first letter no day has. */
const newDayDraft = (draft: TrainingPlanDefinitionDraft): DayDraft => {
  const takenLabels = new Set(draft.days.map((dayDraft) => dayDraft.label.trim()))
  return {
    key: freshDraftKey({
      prefix: 'day',
      takenKeys: draft.days.map((dayDraft) => dayDraft.key),
    }),
    label: Option.getOrElse(
      Arr.findFirst('ABCDEFGHIJKLMNOPQRSTUVWXYZ', (letter) => !takenLabels.has(letter)),
      () => ''
    ),
    exercises: [],
  }
}

/** The blank exercise row "Add exercise" appends, keyed apart from every row of `draft`. */
const newExerciseDraft = (draft: TrainingPlanDefinitionDraft): ExerciseDraft =>
  blankExerciseDraft(freshDraftKey({ prefix: 'exercise', takenKeys: exerciseKeysOf(draft) }))

export { draftFromTrainingPlanDefinition, emptyDraft, newDayDraft, newExerciseDraft }
export type { DayDraft, ExerciseDraft, ExerciseTextField, TrainingPlanDefinitionDraft }
