import { Either } from 'effect'
import { Load, StrongLifts5x5, type TrainingPlanDefinition } from 'lifting-core'
import type { JSX, SubmitEvent } from 'react'
import { useId, useState } from 'react'
import { cn } from 'react-kitchen-sink'
import { ErrorBanner, Field, TextField } from 'react-tundraish'

import { formatUnit } from './load-format.ts'
import {
  addDay,
  addExercise,
  type DayDraft,
  DraftPath,
  type DraftProblems,
  draftFromTrainingPlanDefinition,
  editDay,
  editExercise,
  emptyDraft,
  type ExerciseDraft,
  type ExerciseTextField,
  moveExercise,
  removeDay,
  removeExercise,
  type TrainingPlanDefinitionDraft,
  trainingPlanDefinitionFromDraft,
} from './training-plan-definition-draft.ts'
import styles from './training-plan-definition-editor.module.css'

interface TrainingPlanDefinitionEditorProps {
  /** The training plan definition to edit, or `null` to create one from an empty form. */
  readonly initial: TrainingPlanDefinition.Type | null
  /**
   * The id the saved training plan definition is stored under — `initial.id`
   * to replace it, or one the app minted for a new one.
   */
  readonly planDefinitionId: string
  /** Called with the training plan definition made from the form, once it saves without a problem. */
  readonly onSave: (trainingPlanDefinition: TrainingPlanDefinition.Type) => void
  /** Called when the person abandons the edit; no cancel action is shown without it. */
  readonly onCancel?: () => void
  /** The training plan definition is being saved: the whole form is disabled until it settles. */
  readonly pending?: boolean
  /**
   * Why the last save failed — e.g. a mutation's `error`, passed straight
   * through — shown in an `ErrorBanner`; `null` or absent when it didn't.
   */
  readonly error?: unknown
}

/** No problems — what the form shows before its first save attempt. */
const NO_PROBLEMS: DraftProblems = new Map()

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

/** A problem as the line under its field, or nothing. */
const problemLine = (problem: string | undefined): JSX.Element | undefined =>
  problem === undefined ? undefined : <span className={styles.problem}>{problem}</span>

/** How a day is named in its actions' labels, even before it has a label. */
const dayNameOf = (dayDraft: DayDraft, index: number): string =>
  dayDraft.label.trim() === '' ? `day ${index + 1}` : `day ${dayDraft.label.trim()}`

/** How an exercise row is named in its actions' labels, even before it has a name. */
const exerciseNameOf = (exerciseDraft: ExerciseDraft, index: number): string =>
  exerciseDraft.name.trim() === '' ? `exercise ${index + 1}` : exerciseDraft.name.trim()

/**
 * The **training plan definition editor**: create a training plan definition
 * or edit one — its title, and its days in cycle order, each with its label
 * and its exercises (definitions): name, sets × reps and the progression rule
 * that moves its load — or, for a new one, start from the StrongLifts 5×5
 * template.
 *
 * @remarks
 * Every field is text until "Save" makes the form level by level, as
 * `lifting-core` makes a training plan definition (see
 * `trainingPlanDefinitionFromDraft`): each exercise row, each day, then the
 * whole. The first save that finds a problem shows each one under the field
 * its make's issue path names, with a `role="alert"` line counting them, and
 * from then on the problems track the form as it is corrected; `onSave` only
 * ever receives a made `TrainingPlanDefinition.Type`.
 *
 * An exercise on several days is a row on each, and must be defined alike on
 * each — `TrainingPlanDefinition.make` says so under the later row. An
 * exercise keeps its id when renamed; a new row's id is its name's slug, so a
 * new row named like an existing exercise is that exercise.
 *
 * Loads are not set here: they are the lifter's, on their `ExerciseRequest`s.
 * Start (or restart) the saved training plan definition through
 * `StartTrainingPlanDefinitionView`, which asks a starting load for every
 * exercise — the lifter's current loads offered for the ones they already
 * lift.
 *
 * `initial` seeds the form once, on mount: a caller switching training plan
 * definitions keys the editor on the id. While `pending`, the form sits in a
 * disabled `<fieldset>`.
 */
const TrainingPlanDefinitionEditor = ({
  initial,
  planDefinitionId,
  onSave,
  onCancel,
  pending = false,
  error,
}: TrainingPlanDefinitionEditorProps): JSX.Element => {
  const [draft, setDraft] = useState<TrainingPlanDefinitionDraft>(() =>
    initial === null ? emptyDraft : draftFromTrainingPlanDefinition(initial)
  )
  const [saveAttempted, setSaveAttempted] = useState(false)
  const made = trainingPlanDefinitionFromDraft({ draft, planDefinitionId })
  const shownProblems: DraftProblems = saveAttempted
    ? Either.match(made, { onLeft: (problems) => problems, onRight: () => NO_PROBLEMS })
    : NO_PROBLEMS

  const save = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setSaveAttempted(true)
    Either.match(made, { onLeft: () => undefined, onRight: onSave })
  }

  return (
    <form className={styles.editor} noValidate onSubmit={save}>
      <fieldset className={styles.body} disabled={pending}>
        <div className={styles.titleRow}>
          <TextField
            label="Title"
            value={draft.title}
            onChange={(title) => {
              setDraft((current) => ({ ...current, title }))
            }}
            autoCapitalize="words"
            description={problemLine(shownProblems.get(DraftPath.title))}
          />
          {initial === null ? (
            <button
              type="button"
              className="button-2 outline"
              onClick={() => {
                setDraft(
                  draftFromTrainingPlanDefinition(
                    StrongLifts5x5.trainingPlanDefinition(planDefinitionId)
                  )
                )
              }}
            >
              Start from StrongLifts 5×5
            </button>
          ) : null}
        </div>

        <section className={styles.section}>
          <h2 className={cn('text-heading-6', styles.sectionHeading)}>Days</h2>
          {problemLine(shownProblems.get(DraftPath.days))}
          {draft.days.map((dayDraft, index) => (
            <DayRow
              key={dayDraft.key}
              dayDraft={dayDraft}
              legend={`Day ${index + 1}`}
              dayName={dayNameOf(dayDraft, index)}
              problems={shownProblems}
              onEdit={(edit) => {
                setDraft((current) => editDay({ draft: current, dayKey: dayDraft.key, edit }))
              }}
              onAddExercise={() => {
                setDraft((current) => addExercise({ draft: current, dayKey: dayDraft.key }))
              }}
              onRemove={() => {
                setDraft((current) => removeDay({ draft: current, dayKey: dayDraft.key }))
              }}
            />
          ))}
          <div>
            <button
              type="button"
              className="button-3 outline"
              onClick={() => {
                setDraft(addDay)
              }}
            >
              Add day
            </button>
          </div>
        </section>

        {shownProblems.size === 0 ? null : (
          <p role="alert" className={cn('text-body-3', styles.problem, styles.summary)}>
            {shownProblems.size === 1
              ? '1 problem to fix — see the highlighted field.'
              : `${shownProblems.size} problems to fix — see the highlighted fields.`}
          </p>
        )}
        <ErrorBanner error={error} />
        <div className={styles.actions}>
          {onCancel === undefined ? null : (
            <button type="button" className="button-2 outline" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="submit" className="button-2 filled">
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </fieldset>
    </form>
  )
}

/** One day's label and exercise rows in {@link TrainingPlanDefinitionEditor}, with its actions. */
const DayRow = ({
  dayDraft,
  legend,
  dayName,
  problems,
  onEdit,
  onAddExercise,
  onRemove,
}: {
  readonly dayDraft: DayDraft
  readonly legend: string
  /** How the day is named in its actions' labels. */
  readonly dayName: string
  readonly problems: DraftProblems
  readonly onEdit: (edit: (dayDraft: DayDraft) => DayDraft) => void
  readonly onAddExercise: () => void
  readonly onRemove: () => void
}): JSX.Element => (
  <fieldset className={styles.day}>
    <legend className={cn('text-label-2', styles.legend)}>{legend}</legend>
    <TextField
      label="Label"
      value={dayDraft.label}
      onChange={(label) => {
        onEdit((current) => ({ ...current, label }))
      }}
      autoCapitalize="characters"
      description={problemLine(problems.get(DraftPath.dayLabel(dayDraft.key)))}
    />
    {dayDraft.exercises.map((exerciseDraft, index) => (
      <ExerciseRow
        key={exerciseDraft.key}
        exerciseDraft={exerciseDraft}
        legend={`Exercise ${index + 1}`}
        exerciseName={`${exerciseNameOf(exerciseDraft, index)} in ${dayName}`}
        isFirst={index === 0}
        isLast={index === dayDraft.exercises.length - 1}
        problems={problems}
        onEdit={(patch) => {
          onEdit((current) =>
            editExercise({ dayDraft: current, exerciseKey: exerciseDraft.key, patch })
          )
        }}
        onMove={(offset) => {
          onEdit((current) => moveExercise({ dayDraft: current, index, offset }))
        }}
        onRemove={() => {
          onEdit((current) => removeExercise({ dayDraft: current, exerciseKey: exerciseDraft.key }))
        }}
      />
    ))}
    {problemLine(problems.get(DraftPath.dayExercises(dayDraft.key)))}
    <div className={styles.rowActions}>
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

/** One exercise row's fields in {@link TrainingPlanDefinitionEditor}, with its actions. */
const ExerciseRow = ({
  exerciseDraft,
  legend,
  exerciseName,
  isFirst,
  isLast,
  problems,
  onEdit,
  onMove,
  onRemove,
}: {
  readonly exerciseDraft: ExerciseDraft
  readonly legend: string
  /** How the row is named in its actions' labels, e.g. `"Squat in day A"`. */
  readonly exerciseName: string
  readonly isFirst: boolean
  readonly isLast: boolean
  readonly problems: DraftProblems
  readonly onEdit: (patch: Partial<Pick<ExerciseDraft, ExerciseTextField | 'unit'>>) => void
  readonly onMove: (offset: -1 | 1) => void
  readonly onRemove: () => void
}): JSX.Element => {
  const unitSelectId = useId()
  const problemAt = (field: ExerciseTextField): JSX.Element | undefined =>
    problemLine(problems.get(DraftPath.exerciseField(exerciseDraft.key, field)))
  const unit = formatUnit(exerciseDraft.unit)
  return (
    <fieldset className={styles.exercise}>
      <legend className={cn('text-label-3', styles.legend)}>{legend}</legend>
      <div className={styles.fields}>
        <TextField
          label="Name"
          value={exerciseDraft.name}
          onChange={(name) => {
            onEdit({ name })
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
              if (chosen !== undefined) onEdit({ unit: chosen })
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
              onEdit({ [field]: text })
            }}
            description={problemAt(field)}
          />
        ))}
      </div>
      {problemLine(problems.get(DraftPath.exercise(exerciseDraft.key)))}
      <div className={styles.rowActions}>
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

export { TrainingPlanDefinitionEditor }
export type { TrainingPlanDefinitionEditorProps }
