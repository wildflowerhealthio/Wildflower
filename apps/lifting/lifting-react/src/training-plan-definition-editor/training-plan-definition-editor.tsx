import { StrongLifts5x5, type TrainingPlanDefinition } from '@wildflowerhealthio/lifting-core-js'
import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { ErrorBanner, TextField } from '@wildflowerhealthio/react-tundraish'
import { Either } from 'effect'
import type { JSX, SubmitEvent } from 'react'
import { useState } from 'react'

import { problemDescription } from '../form/problem-description.tsx'
import { useFormState } from '../form/use-form-state.ts'
import { DayRow } from './day-row.tsx'
import { DraftPath, type DraftProblems } from './draft-problems.ts'
import {
  draftFromTrainingPlanDefinition,
  emptyDraft,
  newDayDraft,
  newExerciseDraft,
  type DayDraft,
  type TrainingPlanDefinitionDraft,
} from './training-plan-definition-draft.ts'
import { trainingPlanDefinitionFromDraft } from './training-plan-definition-from-draft.ts'
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

/** How a day is named in its actions' labels, even before it has a label. */
const dayNameOf = (dayDraft: DayDraft, index: number): string =>
  dayDraft.label.trim() === '' ? `day ${index + 1}` : `day ${dayDraft.label.trim()}`

/**
 * The **training plan definition editor**: create a training plan definition
 * or edit one — its title, and its days in cycle order, each with its label
 * and its exercises (definitions): name, sets × reps and the progression rule
 * that moves its load — or, for a new one, start from the StrongLifts 5×5
 * template.
 *
 * @remarks
 * Every field is text until "Save" makes the form level by level, as
 * `lifting-core-js` makes a training plan definition (see
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
  const form = useFormState<TrainingPlanDefinitionDraft>(() =>
    initial === null ? emptyDraft : draftFromTrainingPlanDefinition(initial)
  )
  const [saveAttempted, setSaveAttempted] = useState(false)
  const made = trainingPlanDefinitionFromDraft({ draft: form.value, planDefinitionId })
  const shownProblems: DraftProblems = saveAttempted
    ? Either.match(made, { onLeft: (problems) => problems, onRight: () => NO_PROBLEMS })
    : NO_PROBLEMS

  const save = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setSaveAttempted(true)
    Either.match(made, { onLeft: () => undefined, onRight: onSave })
  }

  return (
    <form className={styles['training-plan-definition-editor']} noValidate onSubmit={save}>
      <fieldset className={styles['training-plan-definition-editor__body']} disabled={pending}>
        <div className={styles['training-plan-definition-editor__title-row']}>
          <TextField
            label="Title"
            value={form.value.title}
            onChange={(title) => {
              form.set('title', title)
            }}
            autoCapitalize="words"
            description={problemDescription(shownProblems.get(DraftPath.title))}
          />
          {initial === null ? (
            <button
              type="button"
              className="button-2 outline"
              onClick={() => {
                form.replace(
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

        <section className={styles['training-plan-definition-editor__section']}>
          <h2
            className={cn(
              'text-heading-6',
              styles['training-plan-definition-editor__section-heading']
            )}
          >
            Days
          </h2>
          {problemDescription(shownProblems.get(DraftPath.days))}
          {form.list('days').map((day, index) => (
            <DayRow
              key={day.value.key}
              day={day}
              legend={`Day ${index + 1}`}
              dayName={dayNameOf(day.value, index)}
              problems={shownProblems}
              onAddExercise={() => {
                day.list('exercises').add(newExerciseDraft(form.value))
              }}
              onRemove={() => {
                form.list('days').remove(index)
              }}
            />
          ))}
          <div>
            <button
              type="button"
              className="button-3 outline"
              onClick={() => {
                form.list('days').add(newDayDraft(form.value))
              }}
            >
              Add day
            </button>
          </div>
        </section>

        {shownProblems.size === 0 ? null : (
          <p
            role="alert"
            className={cn('text-body-3', styles['training-plan-definition-editor__summary'])}
          >
            {shownProblems.size === 1
              ? '1 problem to fix — see the highlighted field.'
              : `${shownProblems.size} problems to fix — see the highlighted fields.`}
          </p>
        )}
        <ErrorBanner error={error} />
        <div className={styles['training-plan-definition-editor__actions']}>
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

export { TrainingPlanDefinitionEditor }
export type { TrainingPlanDefinitionEditorProps }
