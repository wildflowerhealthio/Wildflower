import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { TextField } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

import { problemDescription } from '../form/problem-description.tsx'
import type { FormState } from '../form/use-form-state.ts'
import { DraftPath, type DraftProblems } from './draft-problems.ts'
import { ExerciseRow } from './exercise-row.tsx'
import type { DayDraft, ExerciseDraft } from './training-plan-definition-draft.ts'
import styles from './day-row.module.css'

/** How an exercise row is named in its actions' labels, even before it has a name. */
const exerciseNameOf = (exerciseDraft: ExerciseDraft, index: number): string =>
  exerciseDraft.name.trim() === '' ? `exercise ${index + 1}` : exerciseDraft.name.trim()

/** One day's label and exercise rows in `TrainingPlanDefinitionEditor`, with its actions. */
const DayRow = ({
  day,
  legend,
  dayName,
  problems,
  onAddExercise,
  onRemove,
}: {
  /** The day's part of the form, which its label and exercise rows are edited through. */
  readonly day: FormState<DayDraft>
  readonly legend: string
  /** How the day is named in its actions' labels. */
  readonly dayName: string
  readonly problems: DraftProblems
  /** Appends a blank exercise row, keyed apart from every row of the form. */
  readonly onAddExercise: () => void
  readonly onRemove: () => void
}): JSX.Element => {
  const dayDraft = day.value
  const exercises = day.list('exercises')
  return (
    <fieldset className={styles['day-row']}>
      <legend className={cn('text-label-2', styles['day-row__legend'])}>{legend}</legend>
      <TextField
        label="Label"
        value={dayDraft.label}
        onChange={(label) => {
          day.set('label', label)
        }}
        autoCapitalize="characters"
        description={problemDescription(problems.get(DraftPath.dayLabel(dayDraft.key)))}
      />
      {exercises.map((exercise, index) => (
        <ExerciseRow
          key={exercise.value.key}
          exercise={exercise}
          legend={`Exercise ${index + 1}`}
          exerciseName={`${exerciseNameOf(exercise.value, index)} in ${dayName}`}
          isFirst={index === 0}
          isLast={index === exercises.items.length - 1}
          problems={problems}
          onMove={(offset) => {
            exercises.move(index, offset)
          }}
          onRemove={() => {
            exercises.remove(index)
          }}
        />
      ))}
      {problemDescription(problems.get(DraftPath.dayExercises(dayDraft.key)))}
      <div className={styles['day-row__actions']}>
        <button
          type="button"
          className="button-3 outline"
          aria-label={`Add exercise to ${dayName}`}
          onClick={onAddExercise}
        >
          Add exercise
        </button>
        <button
          type="button"
          className="button-3 outline accent-red"
          aria-label={`Remove ${dayName}`}
          onClick={onRemove}
        >
          Remove day
        </button>
      </div>
    </fieldset>
  )
}

export { DayRow }
