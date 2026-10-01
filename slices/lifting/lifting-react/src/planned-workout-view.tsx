import { Array as Arr, type DateTime, Option, Record as EffectRecord } from 'effect'
import {
  ExerciseConcept,
  ExerciseRequest,
  PlannedWorkout,
  TrainingPlanDefinition,
} from 'lifting-core'
import type { JSX, SubmitEvent } from 'react'
import { useId, useState } from 'react'
import { cn } from 'react-kitchen-sink'
import { ErrorBanner } from 'react-tundraish'

import { formatLoad } from './load-format.ts'
import styles from './planned-workout-view.module.css'

/**
 * A planned workout as the lifter performed it: what `PlannedWorkout.submit`
 * needs beside the planned workout itself, the lifter and the ids the app
 * mints.
 */
interface WorkoutSubmission {
  /** The reps of each set entered, by exercise id, in set order; an exercise with none entered is absent. */
  readonly setRepsByExerciseId: PlannedWorkout.SetRepsByExerciseId
  /** When the first set was entered. */
  readonly start: DateTime.Utc
  /** When the workout was submitted. */
  readonly end: DateTime.Utc
}

interface PlannedWorkoutViewProps {
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

/** The reps entered for each set of one exercise, in set order; `None` for a set not done. */
type EnteredSetReps = readonly Option.Option<number>[]

/**
 * The reps a set button holds after a tap: a set not done starts at the reps
 * asked for, each tap takes one off, and a tap at 0 makes it not done again.
 */
const setRepsAfterTap = ({
  setReps,
  repsAskedFor,
}: {
  readonly setReps: Option.Option<number>
  readonly repsAskedFor: number
}): Option.Option<number> =>
  Option.match(setReps, {
    onNone: () => Option.some(repsAskedFor),
    onSome: (reps) => (reps === 0 ? Option.none() : Option.some(reps - 1)),
  })

/** The exercise's name, from its exercise (definition). */
const exerciseNameOf = (plannedWorkoutExercise: PlannedWorkout.Exercise): string =>
  ExerciseConcept.nameOf(
    TrainingPlanDefinition.Exercise.exerciseConceptOf(
      plannedWorkoutExercise.trainingPlanDefinitionExercise
    )
  )

/**
 * Identifies one planned workout: its day, and per exercise the
 * `ExerciseRequest` worked at and how many attempts it has — so a workout
 * submitted and planned again (even the same day at the same loads) starts
 * with nothing entered.
 */
const plannedWorkoutKeyOf = (plannedWorkout: PlannedWorkout.Type): string =>
  [
    TrainingPlanDefinition.Day.labelOf(plannedWorkout.trainingPlanDefinitionDay),
    ...plannedWorkout.plannedWorkoutExercises.map(
      ({ exerciseRequest, attempts }) => `${exerciseRequest.id}#${attempts.length}`
    ),
  ].join('|')

/**
 * The **planned workout**: the day due, and each of its exercises with its
 * load, sets × reps, how many failures in a row it has toward a deload, and a
 * button per set to enter the reps done.
 *
 * @remarks
 * Every value comes from `lifting-core`: the day and exercises from the
 * `PlannedWorkout`, the load and sets × reps from its `ExerciseRequest`, and
 * "failure N of M" from `PlannedWorkout.consecutiveFailuresOf` and
 * `failuresBeforeDeloadOf` (shown once N is above 0).
 *
 * Each set button starts not done. A tap enters the reps asked for, each
 * further tap takes one off, and a tap at 0 makes the set not done again —
 * one thumb per set, no keyboard. "Submit workout" hands `onSubmit` the
 * entered sets of each exercise in set order (a set not done is left out, so
 * an exercise with none is no attempt and holds), with the workout's span;
 * it is enabled once a set is entered.
 *
 * What is entered resets when another workout is planned (see
 * {@link plannedWorkoutKeyOf}).
 */
const PlannedWorkoutView = (props: PlannedWorkoutViewProps): JSX.Element => (
  <PlannedWorkoutForm key={plannedWorkoutKeyOf(props.plannedWorkout)} {...props} />
)

/** {@link PlannedWorkoutView}'s body for one planned workout, holding the reps entered so far. */
const PlannedWorkoutForm = ({
  plannedWorkout,
  now,
  onSubmit,
  pending = false,
  error,
}: PlannedWorkoutViewProps): JSX.Element => {
  const headingId = useId()
  const [enteredSetRepsByExerciseId, setEnteredSetRepsByExerciseId] = useState<
    EffectRecord.ReadonlyRecord<string, EnteredSetReps>
  >({})
  const [start, setStart] = useState<Option.Option<DateTime.Utc>>(Option.none())

  const enteredSetRepsOf = (plannedWorkoutExercise: PlannedWorkout.Exercise): EnteredSetReps =>
    Option.getOrElse(
      EffectRecord.get(
        enteredSetRepsByExerciseId,
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
    if (Option.isNone(start)) setStart(Option.some(now()))
    setEnteredSetRepsByExerciseId((current) => ({
      ...current,
      [PlannedWorkout.exerciseIdOf(plannedWorkoutExercise)]: Arr.modify(
        enteredSetRepsOf(plannedWorkoutExercise),
        setIndex,
        (setReps) =>
          setRepsAfterTap({
            setReps,
            repsAskedFor: ExerciseRequest.repsOf(plannedWorkoutExercise.exerciseRequest),
          })
      ),
    }))
  }

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!anySetEntered) return
    const end = now()
    onSubmit({ setRepsByExerciseId, start: Option.getOrElse(start, () => end), end })
  }

  const dayLabel = TrainingPlanDefinition.Day.labelOf(plannedWorkout.trainingPlanDefinitionDay)
  return (
    <form className={styles.workout} aria-labelledby={headingId} noValidate onSubmit={submit}>
      <h2 id={headingId} className={cn('text-heading-6', styles.heading)}>
        Workout {dayLabel}
      </h2>
      <ErrorBanner error={error} />
      <ol className={styles.exercises}>
        {plannedWorkout.plannedWorkoutExercises.map((plannedWorkoutExercise) => {
          const { exerciseRequest } = plannedWorkoutExercise
          const exerciseName = exerciseNameOf(plannedWorkoutExercise)
          const repsAskedFor = ExerciseRequest.repsOf(exerciseRequest)
          const consecutiveFailures = PlannedWorkout.consecutiveFailuresOf(plannedWorkoutExercise)
          return (
            <li
              key={PlannedWorkout.exerciseIdOf(plannedWorkoutExercise)}
              className={styles.exercise}
            >
              <div className={styles.exerciseHeader}>
                <h3 className={cn('text-body-2', styles.exerciseName)}>{exerciseName}</h3>
                <span className="text-body-3">
                  {formatLoad(ExerciseRequest.loadOf(exerciseRequest))} ·{' '}
                  {ExerciseRequest.setsOf(exerciseRequest)}×{repsAskedFor}
                </span>
              </div>
              {consecutiveFailures > 0 ? (
                <p className={cn('text-body-3', styles.failures)}>
                  Failure {consecutiveFailures} of{' '}
                  {PlannedWorkout.failuresBeforeDeloadOf(plannedWorkoutExercise)} before a deload
                </p>
              ) : null}
              <div className={styles.sets} role="group" aria-label={`${exerciseName} sets`}>
                {enteredSetRepsOf(plannedWorkoutExercise).map((setReps, setIndex) => (
                  <button
                    // oxlint-disable-next-line react/no-array-index-key -- sets have no id; set N is always the Nth button
                    key={setIndex}
                    type="button"
                    className={cn(
                      styles.set,
                      Option.match(setReps, {
                        onNone: () => styles.setNotDone,
                        onSome: (reps) => (reps < repsAskedFor ? styles.setShort : null),
                      }),
                      'text-body-2'
                    )}
                    aria-label={Option.match(setReps, {
                      onNone: () => `${exerciseName} set ${setIndex + 1}: not done`,
                      onSome: (reps) =>
                        `${exerciseName} set ${setIndex + 1}: ${reps} of ${repsAskedFor} reps`,
                    })}
                    disabled={pending}
                    onClick={() => {
                      tapSet(plannedWorkoutExercise, setIndex)
                    }}
                  >
                    {Option.getOrElse(Option.map(setReps, String), () => '')}
                  </button>
                ))}
              </div>
            </li>
          )
        })}
      </ol>
      <div className={styles.actions}>
        <button type="submit" className="button-2 filled" disabled={pending || !anySetEntered}>
          {pending ? 'Submitting…' : 'Submit workout'}
        </button>
      </div>
    </form>
  )
}

export { PlannedWorkoutView }
export type { PlannedWorkoutViewProps, WorkoutSubmission }
