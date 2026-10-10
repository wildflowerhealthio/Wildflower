import {
  ExerciseRequest,
  PlannedWorkout,
  TrainingPlanDefinition,
} from '@wildflowerhealthio/lifting-core-js'
import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { ErrorBanner } from '@wildflowerhealthio/react-tundraish'
import { Array as Arr, type DateTime, Option, Record as EffectRecord } from 'effect'
import type { JSX, SubmitEvent } from 'react'
import { useId } from 'react'

import { useFormState } from '../form/use-form-state.ts'
import { type EnteredSetReps, setRepsAfterTap } from './entered-set-reps.ts'
import { PlannedWorkoutExercise } from './planned-workout-exercise.tsx'
import type { WorkoutSubmission } from './workout-submission.ts'
import styles from './planned-workout-form.module.css'

interface PlannedWorkoutFormProps {
  /** The workout due, as `PlannedWorkout.make` planned it. */
  readonly plannedWorkout: PlannedWorkout.Type
  /**
   * The clock, read when the first set is entered (the workout's start) and
   * when it is submitted (its end) — never while rendering.
   */
  readonly now: () => DateTime.Utc
  /** Called once per "Submit workout" with the reps entered and the workout's span. */
  readonly onSubmit: (workoutSubmission: WorkoutSubmission) => void
  /** The submitted workout is being written: every control is disabled until it settles. */
  readonly pending?: boolean
  /**
   * Why the last write failed — e.g. a mutation's `error`, passed straight
   * through — shown in an `ErrorBanner`; `null` or absent when it didn't.
   */
  readonly error?: unknown
}

/** What the lifter has entered of a planned workout so far. */
interface WorkoutEntry {
  /** The sets of each exercise a set has been entered for, by exercise id. */
  readonly enteredSetRepsByExerciseId: EffectRecord.ReadonlyRecord<string, EnteredSetReps>
  /** When the first set was entered; `None` until then. */
  readonly start: Option.Option<DateTime.Utc>
}

/** Nothing entered yet. */
const EMPTY_WORKOUT_ENTRY: WorkoutEntry = {
  enteredSetRepsByExerciseId: {},
  start: Option.none(),
}

/**
 * `PlannedWorkoutView`'s body for one planned workout: its heading, an
 * exercise card per exercise and the submit action, holding the reps entered
 * so far.
 */
const PlannedWorkoutForm = ({
  plannedWorkout,
  now,
  onSubmit,
  pending = false,
  error,
}: PlannedWorkoutFormProps): JSX.Element => {
  const headingId = useId()
  const form = useFormState(EMPTY_WORKOUT_ENTRY)

  const enteredSetRepsOf = (plannedWorkoutExercise: PlannedWorkout.Exercise): EnteredSetReps =>
    Option.getOrElse(
      EffectRecord.get(
        form.value.enteredSetRepsByExerciseId,
        PlannedWorkout.exerciseIdOf(plannedWorkoutExercise)
      ),
      () =>
        Arr.replicate(
          Option.none<number>(),
          ExerciseRequest.setsOf(plannedWorkoutExercise.exerciseRequest)
        )
    )
  const setRepsByExerciseId: PlannedWorkout.SetRepsByExerciseId = Object.fromEntries(
    plannedWorkout.plannedWorkoutExercises.flatMap((plannedWorkoutExercise) => {
      const setReps = Arr.getSomes(enteredSetRepsOf(plannedWorkoutExercise))
      return setReps.length === 0
        ? []
        : [[PlannedWorkout.exerciseIdOf(plannedWorkoutExercise), setReps] as const]
    })
  )
  const anySetEntered = Object.keys(setRepsByExerciseId).length > 0

  const tapSet = (plannedWorkoutExercise: PlannedWorkout.Exercise, setIndex: number): void => {
    if (Option.isNone(form.value.start)) form.set('start', Option.some(now()))
    form.field('enteredSetRepsByExerciseId').set(
      PlannedWorkout.exerciseIdOf(plannedWorkoutExercise),
      Arr.modify(enteredSetRepsOf(plannedWorkoutExercise), setIndex, (setReps) =>
        setRepsAfterTap({
          setReps,
          repsAskedFor: ExerciseRequest.repsOf(plannedWorkoutExercise.exerciseRequest),
        })
      )
    )
  }

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!anySetEntered) return
    const end = now()
    onSubmit({ setRepsByExerciseId, start: Option.getOrElse(form.value.start, () => end), end })
  }

  const dayLabel = TrainingPlanDefinition.Day.labelOf(plannedWorkout.trainingPlanDefinitionDay)
  return (
    <form
      className={styles['planned-workout-form']}
      aria-labelledby={headingId}
      noValidate
      onSubmit={submit}
    >
      <h2 id={headingId} className={cn('text-heading-6', styles['planned-workout-form__heading'])}>
        Workout {dayLabel}
      </h2>
      <ErrorBanner error={error} />
      <ol className={styles['planned-workout-form__exercises']}>
        {plannedWorkout.plannedWorkoutExercises.map((plannedWorkoutExercise) => (
          <PlannedWorkoutExercise
            key={PlannedWorkout.exerciseIdOf(plannedWorkoutExercise)}
            plannedWorkoutExercise={plannedWorkoutExercise}
            enteredSetReps={enteredSetRepsOf(plannedWorkoutExercise)}
            pending={pending}
            onTapSet={(setIndex) => {
              tapSet(plannedWorkoutExercise, setIndex)
            }}
          />
        ))}
      </ol>
      <div className={styles['planned-workout-form__actions']}>
        <button type="submit" className="button-2 filled" disabled={pending || !anySetEntered}>
          {pending ? 'Submitting…' : 'Submit workout'}
        </button>
      </div>
    </form>
  )
}

export { PlannedWorkoutForm }
export type { PlannedWorkoutFormProps }
