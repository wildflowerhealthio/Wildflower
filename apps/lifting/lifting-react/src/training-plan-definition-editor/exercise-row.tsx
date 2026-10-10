import { Load } from '@wildflowerhealthio/lifting-core-js'
import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { Field, TextField } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'
import { useId } from 'react'

import { problemDescription } from '../form/problem-description.tsx'
import type { FormState } from '../form/use-form-state.ts'
import { formatUnit } from '../load-format.ts'
import { DraftPath, type DraftProblems } from './draft-problems.ts'
import type { ExerciseDraft, ExerciseTextField } from './training-plan-definition-draft.ts'
import styles from './exercise-row.module.css'

/** One numeric field of an exercise row: the draft field it edits, its label, and its keyboard. */
interface NumericExerciseField {
  readonly field: Exclude<ExerciseTextField, 'name'>
  /** The label, given the unit the row's amounts are in. */
  readonly label: (unit: string) => string
  readonly inputMode: 'decimal' | 'numeric'
}

/** The numeric fields of an exercise row, in the order the form shows them. */
const NUMERIC_EXERCISE_FIELDS: readonly NumericExerciseField[] = [
  { field: 'sets', label: () => 'Sets', inputMode: 'numeric' },
  { field: 'reps', label: () => 'Reps', inputMode: 'numeric' },
  { field: 'increment', label: (unit) => `Increment (${unit})`, inputMode: 'decimal' },
  { field: 'loadStep', label: (unit) => `Load step (${unit})`, inputMode: 'decimal' },
  { field: 'minimumLoad', label: (unit) => `Minimum load (${unit})`, inputMode: 'decimal' },
  { field: 'failuresBeforeDeload', label: () => 'Failures before deload', inputMode: 'numeric' },
  { field: 'deloadFraction', label: () => 'Deload fraction', inputMode: 'decimal' },
]

/** One exercise row's fields in `TrainingPlanDefinitionEditor`, with its actions. */
const ExerciseRow = ({
  exercise,
  legend,
  exerciseName,
  isFirst,
  isLast,
  problems,
  onMove,
  onRemove,
}: {
  /** The row's part of the form, which its fields are edited through. */
  readonly exercise: FormState<ExerciseDraft>
  readonly legend: string
  /** How the row is named in its actions' labels, e.g. `"Squat in day A"`. */
  readonly exerciseName: string
  readonly isFirst: boolean
  readonly isLast: boolean
  readonly problems: DraftProblems
  readonly onMove: (offset: -1 | 1) => void
  readonly onRemove: () => void
}): JSX.Element => {
  const unitSelectId = useId()
  const exerciseDraft = exercise.value
  const problemAt = (field: ExerciseTextField): JSX.Element | undefined =>
    problemDescription(problems.get(DraftPath.exerciseField(exerciseDraft.key, field)))
  const unit = formatUnit(exerciseDraft.unit)
  return (
    <fieldset className={styles['exercise-row']}>
      <legend className={cn('text-label-3', styles['exercise-row__legend'])}>{legend}</legend>
      <div className={styles['exercise-row__fields']}>
        <TextField
          label="Name"
          value={exerciseDraft.name}
          onChange={(name) => {
            exercise.set('name', name)
          }}
          autoCapitalize="words"
          description={problemAt('name')}
        />
        <Field label="Unit" htmlFor={unitSelectId}>
          <select
            id={unitSelectId}
            className="input-3"
            value={exerciseDraft.unit}
            onChange={(event) => {
              const chosen = Load.UnitSchema.literals.find(
                (candidate) => candidate === event.currentTarget.value
              )
              if (chosen !== undefined) exercise.set('unit', chosen)
            }}
          >
            {Load.UnitSchema.literals.map((candidate) => (
              <option key={candidate} value={candidate}>
                {formatUnit(candidate)}
              </option>
            ))}
          </select>
        </Field>
        {NUMERIC_EXERCISE_FIELDS.map(({ field, label, inputMode }) => (
          <TextField
            key={field}
            label={label(unit)}
            value={exerciseDraft[field]}
            inputMode={inputMode}
            onChange={(text) => {
              exercise.set(field, text)
            }}
            description={problemAt(field)}
          />
        ))}
      </div>
      {problemDescription(problems.get(DraftPath.exercise(exerciseDraft.key)))}
      <div className={styles['exercise-row__actions']}>
        <button
          type="button"
          className="button-1 ghost"
          aria-label={`Move ${exerciseName} earlier`}
          disabled={isFirst}
          onClick={() => {
            onMove(-1)
          }}
        >
          ↑
        </button>
        <button
          type="button"
          className="button-1 ghost"
          aria-label={`Move ${exerciseName} later`}
          disabled={isLast}
          onClick={() => {
            onMove(1)
          }}
        >
          ↓
        </button>
        <button
          type="button"
          className="button-3 outline accent-red"
          aria-label={`Remove ${exerciseName}`}
          onClick={onRemove}
        >
          Remove exercise
        </button>
      </div>
    </fieldset>
  )
}

export { ExerciseRow }
