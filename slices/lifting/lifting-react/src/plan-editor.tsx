import { Either } from 'effect'
import { type Plan, strongLifts5x5 } from 'lifting-core'
import type { JSX, SubmitEvent } from 'react'
import { useId, useState } from 'react'
import { cn } from 'react-kitchen-sink'
import { ErrorBanner, Field, FieldGroup, TextField } from 'react-tundraish'

import {
  addExercise,
  addWorkout,
  DraftPath,
  draftFromPlan,
  editExercise,
  editWorkout,
  emptyPlanDraft,
  type ExerciseDraft,
  type ExerciseField,
  moveWorkoutExercise,
  type PlanDraft,
  type PlanDraftProblems,
  planFromDraft,
  removeExercise,
  removeWorkout,
  type WorkoutDraft,
} from './plan-draft.ts'
import styles from './plan-editor.module.css'

interface PlanEditorProps {
  /** The plan to edit, or `null` to create one from an empty form. */
  readonly initial: Plan | null
  /** Called with the decoded, well-formed plan when the form saves without a problem. */
  readonly onSave: (plan: Plan) => void
  /** Called when the person abandons the edit; no cancel action is shown without it. */
  readonly onCancel?: () => void
  /** The plan is being saved: the whole form is disabled until it settles. */
  readonly pending?: boolean
  /**
   * Why the last save failed — e.g. a mutation's `error`, passed straight
   * through — shown in an `ErrorBanner`; `null` or absent when it didn't.
   */
  readonly error?: unknown
}

/** No problems — what the form shows before its first save attempt. */
const noProblems: PlanDraftProblems = new Map()

/** One numeric exercise field: the draft field it edits, its label, and its keyboard. */
interface NumericExerciseField {
  readonly field: Exclude<ExerciseField, 'name'>
  readonly label: string
  readonly inputMode: 'decimal' | 'numeric'
}

/** The numeric fields of an exercise row, in the order the form shows them. */
const numericExerciseFields: readonly NumericExerciseField[] = [
  { field: 'loadLb', label: 'Load (lb)', inputMode: 'decimal' },
  { field: 'sets', label: 'Sets', inputMode: 'numeric' },
  { field: 'reps', label: 'Reps', inputMode: 'numeric' },
  { field: 'incrementLb', label: 'Increment (lb)', inputMode: 'decimal' },
  { field: 'loadStepLb', label: 'Plate step (lb)', inputMode: 'decimal' },
  { field: 'minimumLoadLb', label: 'Minimum load (lb)', inputMode: 'decimal' },
  { field: 'failuresBeforeDeload', label: 'Failures before deload', inputMode: 'numeric' },
  { field: 'deloadPercent', label: 'Deload (%)', inputMode: 'decimal' },
]

/** A problem as the helper line under its field, or nothing. */
const problemLine = (problem: string | undefined): JSX.Element | undefined =>
  problem === undefined ? undefined : <span className={styles.problem}>{problem}</span>

/** The name an exercise row goes by in the workout lists, even before it has one. */
const exerciseLabel = (exerciseDraft: ExerciseDraft, index: number): string =>
  exerciseDraft.name.trim() === '' ? `Exercise ${index + 1}` : exerciseDraft.name.trim()

/**
 * The **plan editor**: create a plan or edit one — its title, each exercise's
 * prescription and progression rule, and the workouts with their exercises in
 * order — or, for a new plan, start from the StrongLifts 5×5 template.
 *
 * @remarks
 * Every field is text until "Save plan" decodes the whole form (see
 * `planFromDraft`). The first save that finds a problem shows each one under
 * its field, and from then on the problems track the form as it's corrected;
 * `onSave` only ever receives a well-formed `Plan`. A refused save is
 * announced by a `role="alert"` line counting the problems.
 *
 * `initial` seeds the form once, on mount: a later change to it does not
 * reset the draft, so a caller switching plans keys the editor on the plan's
 * id. The StrongLifts seed is offered only for a new plan (`initial` is
 * `null`), so an existing plan is never replaced by a stray tap.
 *
 * An exercise the plan already has keeps its id when renamed — attempts are
 * keyed by it. A new exercise's id is `lifting-core`'s `exerciseIdFromName`
 * of its name (`"Bench Press"` → `bench-press`).
 *
 * While `pending`, the form sits in a disabled `<fieldset>`, so no field or
 * action can change mid-save.
 */
const PlanEditor = ({
  initial,
  onSave,
  onCancel,
  pending = false,
  error,
}: PlanEditorProps): JSX.Element => {
  const [draft, setDraft] = useState<PlanDraft>(() =>
    initial === null ? emptyPlanDraft : draftFromPlan(initial)
  )
  const [saveAttempted, setSaveAttempted] = useState(false)
  const decoded = planFromDraft(draft)
  const shownProblems: PlanDraftProblems = saveAttempted
    ? Either.match(decoded, { onLeft: (draftProblems) => draftProblems, onRight: () => noProblems })
    : noProblems

  const save = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setSaveAttempted(true)
    Either.match(decoded, { onLeft: () => undefined, onRight: onSave })
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
                setDraft(draftFromPlan(strongLifts5x5()))
              }}
            >
              Start from StrongLifts 5×5
            </button>
          ) : null}
        </div>

        <section className={styles.section}>
          <h2 className={cn('text-heading-6', styles.sectionHeading)}>Exercises</h2>
          {draft.exercises.map((exerciseDraft, index) => (
            <ExerciseRow
              key={exerciseDraft.key}
              exerciseDraft={exerciseDraft}
              legend={`Exercise ${index + 1}`}
              problems={shownProblems}
              onEdit={(patch) => {
                setDraft((current) => editExercise(current, exerciseDraft.key, patch))
              }}
              onRemove={() => {
                setDraft((current) => removeExercise(current, exerciseDraft.key))
              }}
            />
          ))}
          <div>
            <button
              type="button"
              className="button-3 outline"
              onClick={() => {
                setDraft(addExercise)
              }}
            >
              Add exercise
            </button>
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={cn('text-heading-6', styles.sectionHeading)}>Workouts</h2>
          {problemLine(shownProblems.get(DraftPath.workouts))}
          {draft.workouts.map((workoutDraft, index) => (
            <WorkoutRow
              key={workoutDraft.key}
              workoutDraft={workoutDraft}
              legend={`Workout ${index + 1}`}
              exercises={draft.exercises}
              problems={shownProblems}
              onEdit={(edit) => {
                setDraft((current) => editWorkout(current, workoutDraft.key, edit))
              }}
              onRemove={() => {
                setDraft((current) => removeWorkout(current, workoutDraft.key))
              }}
            />
          ))}
          <div>
            <button
              type="button"
              className="button-3 outline"
              onClick={() => {
                setDraft(addWorkout)
              }}
            >
              Add workout
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
            {pending ? 'Saving…' : 'Save plan'}
          </button>
        </div>
      </fieldset>
    </form>
  )
}

/** One exercise's fields in {@link PlanEditor}, with its remove action. */
const ExerciseRow = ({
  exerciseDraft,
  legend,
  problems,
  onEdit,
  onRemove,
}: {
  readonly exerciseDraft: ExerciseDraft
  readonly legend: string
  readonly problems: PlanDraftProblems
  readonly onEdit: (patch: Partial<Pick<ExerciseDraft, ExerciseField>>) => void
  readonly onRemove: () => void
}): JSX.Element => {
  const problemAt = (field: ExerciseField): JSX.Element | undefined =>
    problemLine(problems.get(DraftPath.exercise(exerciseDraft.key, field)))
  return (
    <fieldset className={styles.row}>
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
        {numericExerciseFields.map(({ field, label, inputMode }) => (
          <TextField
            key={field}
            label={label}
            value={exerciseDraft[field]}
            inputMode={inputMode}
            onChange={(text) => {
              onEdit({ [field]: text })
            }}
            description={problemAt(field)}
          />
        ))}
      </div>
      <div>
        <button type="button" className="button-3 outline accent-red" onClick={onRemove}>
          Remove exercise
        </button>
      </div>
    </fieldset>
  )
}

/** One workout's label and ordered exercises in {@link PlanEditor}, with its remove action. */
const WorkoutRow = ({
  workoutDraft,
  legend,
  exercises,
  problems,
  onEdit,
  onRemove,
}: {
  readonly workoutDraft: WorkoutDraft
  readonly legend: string
  readonly exercises: readonly ExerciseDraft[]
  readonly problems: PlanDraftProblems
  readonly onEdit: (edit: (workoutDraft: WorkoutDraft) => WorkoutDraft) => void
  readonly onRemove: () => void
}): JSX.Element => {
  const addSelectId = useId()
  const labelByKey = new Map(
    exercises.map((exerciseDraft, index) => [
      exerciseDraft.key,
      exerciseLabel(exerciseDraft, index),
    ])
  )
  const workoutName =
    workoutDraft.label.trim() === '' ? legend : `workout ${workoutDraft.label.trim()}`
  const addable = exercises.filter(
    (exerciseDraft) => !workoutDraft.exerciseKeys.includes(exerciseDraft.key)
  )
  return (
    <fieldset className={styles.row}>
      <legend className={cn('text-label-3', styles.legend)}>{legend}</legend>
      <TextField
        label="Label"
        value={workoutDraft.label}
        onChange={(label) => {
          onEdit((current) => ({ ...current, label }))
        }}
        autoCapitalize="characters"
        description={problemLine(problems.get(DraftPath.workout(workoutDraft.key, 'label')))}
      />
      <FieldGroup label={`Exercises in ${workoutName}, in order`}>
        <ol className={styles.members}>
          {workoutDraft.exerciseKeys.map((exerciseKey, index) => {
            const name = labelByKey.get(exerciseKey) ?? exerciseKey
            return (
              <li key={exerciseKey} className={styles.member}>
                <span className="text-body-2">{name}</span>
                <span className={styles.memberActions}>
                  <button
                    type="button"
                    className="button-1 ghost"
                    aria-label={`Move ${name} earlier in ${workoutName}`}
                    disabled={index === 0}
                    onClick={() => {
                      onEdit(moveWorkoutExercise(index, -1))
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="button-1 ghost"
                    aria-label={`Move ${name} later in ${workoutName}`}
                    disabled={index === workoutDraft.exerciseKeys.length - 1}
                    onClick={() => {
                      onEdit(moveWorkoutExercise(index, 1))
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="button-1 ghost accent-red"
                    aria-label={`Remove ${name} from ${workoutName}`}
                    onClick={() => {
                      onEdit((current) => ({
                        ...current,
                        exerciseKeys: current.exerciseKeys.filter((key) => key !== exerciseKey),
                      }))
                    }}
                  >
                    ✕
                  </button>
                </span>
              </li>
            )
          })}
        </ol>
        {problemLine(problems.get(DraftPath.workout(workoutDraft.key, 'exerciseKeys')))}
      </FieldGroup>
      {addable.length === 0 ? null : (
        <Field label={`Add to ${workoutName}`} htmlFor={addSelectId}>
          <select
            id={addSelectId}
            className="input-3"
            value=""
            onChange={(event) => {
              const exerciseKey = event.currentTarget.value
              if (exerciseKey === '') return
              onEdit((current) => ({
                ...current,
                exerciseKeys: [...current.exerciseKeys, exerciseKey],
              }))
            }}
          >
            <option value="">Choose an exercise…</option>
            {addable.map((exerciseDraft) => (
              <option key={exerciseDraft.key} value={exerciseDraft.key}>
                {labelByKey.get(exerciseDraft.key)}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div>
        <button type="button" className="button-3 outline accent-red" onClick={onRemove}>
          Remove workout
        </button>
      </div>
    </fieldset>
  )
}

export { PlanEditor }
export type { PlanEditorProps }
