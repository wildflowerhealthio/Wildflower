import { Array as Arr, type DateTime } from 'effect'
import {
  consecutiveFailures,
  type ExerciseAttempt,
  type ExerciseGoal,
  goalsFor,
  nextWorkout,
  type Plan,
  type Workout,
} from 'lifting-core'
import type { JSX } from 'react'
import { useId, useState } from 'react'
import { cn } from 'react-kitchen-sink'
import { ErrorBanner } from 'react-tundraish'

import { formatLoadLb } from './load-format.ts'
import styles from './today-view.module.css'

interface TodayViewProps {
  /** The plan being followed. */
  readonly plan: Plan
  /** Every attempt logged against the plan, in any order. */
  readonly attempts: readonly ExerciseAttempt[]
  /**
   * The clock a logged session is stamped with, read once when "Log session"
   * is pressed — so a screen left open still logs the time it was finished.
   */
  readonly now: () => DateTime.Utc
  /** Called with one attempt per exercise of the due workout, in workout order. */
  readonly onLogSession: (sessionAttempts: readonly ExerciseAttempt[]) => void
  /** A logged session is being saved: every control is disabled until it settles. */
  readonly pending?: boolean
  /**
   * Why the last save failed — e.g. a mutation's `error`, passed straight
   * through — shown in an `ErrorBanner`; `null` or absent when it didn't.
   */
  readonly error?: unknown
}

/** The reps a set button shows after a tap: one fewer, wrapping from 0 back to the prescription. */
const repsAfterTap = (setReps: number, prescribedReps: number): number =>
  setReps === 0 ? prescribedReps : setReps - 1

/** Every set of every goal at its prescribed reps — where a session starts. */
const prescribedRepsByExercise = (
  goals: readonly ExerciseGoal[]
): Readonly<Record<string, readonly number[]>> =>
  Object.fromEntries(goals.map((goal) => [goal.exercise.id, Arr.replicate(goal.reps, goal.sets)]))

/**
 * The **today screen**: the workout due next, each of its exercises with its
 * load and sets × reps, and a row of set buttons to log the session with.
 *
 * @remarks
 * Every decision comes from `lifting-core`: the due workout from
 * `nextWorkout`, its goals from `goalsFor`, and the "failed N of M" note from
 * `consecutiveFailures` against the goal's `failuresBeforeDeload`.
 *
 * Each prescribed set is one button showing the reps completed. It starts at
 * the prescription; a tap takes one rep off, and a tap at 0 wraps back to the
 * prescription — the StrongLifts-app gesture, one thumb per set, no keyboard.
 * "Log session" hands `onLogSession` one `ExerciseAttempt` per exercise, at
 * the goal's load and sets × reps, stamped with `now()`.
 *
 * The set buttons reset whenever a session is added to `attempts`, the due
 * workout changes, or a due goal's prescription (load, sets or reps) changes —
 * so a logged attempt's `repsCompleted` always has one entry per
 * `prescribedSets`.
 */
const TodayView = ({
  plan,
  attempts,
  now,
  onLogSession,
  pending = false,
  error,
}: TodayViewProps): JSX.Element => {
  const workout = nextWorkout(plan, attempts)
  const goals = goalsFor(plan, workout)
  // A new logged session, a different workout, or an edited prescription
  // starts a fresh logger.
  const prescriptionKey = goals
    .map((goal) => `${goal.exercise.id}:${goal.sets}x${goal.reps}@${goal.loadLb}`)
    .join('|')
  return (
    <SessionLogger
      key={`${workout.label}#${attempts.length}#${prescriptionKey}`}
      workout={workout}
      goals={goals}
      attempts={attempts}
      now={now}
      onLogSession={onLogSession}
      pending={pending}
      error={error}
    />
  )
}

/** {@link TodayView}'s body for one due workout, holding the reps logged so far. */
const SessionLogger = ({
  workout,
  goals,
  attempts,
  now,
  onLogSession,
  pending,
  error,
}: {
  readonly workout: Workout
  readonly goals: readonly ExerciseGoal[]
  readonly attempts: readonly ExerciseAttempt[]
  readonly now: () => DateTime.Utc
  readonly onLogSession: (sessionAttempts: readonly ExerciseAttempt[]) => void
  readonly pending: boolean
  readonly error: unknown
}): JSX.Element => {
  const headingId = useId()
  const [repsByExercise, setRepsByExercise] = useState(() => prescribedRepsByExercise(goals))
  // Reps held for a different number of sets belong to an older prescription;
  // they are dropped rather than logged against this one.
  const repsFor = (goal: ExerciseGoal): readonly number[] => {
    const heldReps = repsByExercise[goal.exercise.id]
    return heldReps !== undefined && heldReps.length === goal.sets
      ? heldReps
      : Arr.replicate(goal.reps, goal.sets)
  }

  const tapSet = (goal: ExerciseGoal, setIndex: number): void => {
    setRepsByExercise((current) => ({
      ...current,
      [goal.exercise.id]: Arr.modify(repsFor(goal), setIndex, (setReps) =>
        repsAfterTap(setReps, goal.reps)
      ),
    }))
  }

  const logSession = (): void => {
    const performedAt = now()
    onLogSession(
      goals.map((goal) => ({
        exercise: goal.exercise,
        workoutLabel: workout.label,
        performedAt,
        loadLb: goal.loadLb,
        prescribedSets: goal.sets,
        prescribedReps: goal.reps,
        repsCompleted: repsFor(goal),
      }))
    )
  }

  return (
    <section className={styles.today} aria-labelledby={headingId}>
      <h2 id={headingId} className={cn('text-heading-6', styles.heading)}>
        Workout {workout.label}
      </h2>
      <ErrorBanner error={error} />
      <ol className={styles.exercises}>
        {goals.map((goal) => {
          const failures = consecutiveFailures(goal, attempts)
          return (
            <li key={goal.exercise.id} className={styles.exercise}>
              <div className={styles.exerciseHeader}>
                <h3 className={cn('text-body-2', styles.exerciseName)}>{goal.exercise.name}</h3>
                <span className="text-body-3">
                  {formatLoadLb(goal.loadLb)} · {goal.sets}×{goal.reps}
                </span>
              </div>
              {failures > 0 ? (
                <p className={cn('text-body-3', styles.failures)}>
                  Failed {failures} of {goal.progression.failuresBeforeDeload} before a deload
                </p>
              ) : null}
              <div className={styles.sets} role="group" aria-label={`${goal.exercise.name} sets`}>
                {repsFor(goal).map((setReps, setIndex) => (
                  <button
                    // oxlint-disable-next-line react/no-array-index-key -- sets have no id; set N is always the Nth button
                    key={setIndex}
                    type="button"
                    className={cn(
                      styles.set,
                      setReps < goal.reps ? styles.setShort : null,
                      'text-body-2'
                    )}
                    aria-label={`${goal.exercise.name} set ${setIndex + 1}: ${setReps} of ${goal.reps} reps`}
                    disabled={pending}
                    onClick={() => {
                      tapSet(goal, setIndex)
                    }}
                  >
                    {setReps}
                  </button>
                ))}
              </div>
            </li>
          )
        })}
      </ol>
      <div className={styles.actions}>
        <button type="button" className="button-2 filled" disabled={pending} onClick={logSession}>
          {pending ? 'Logging…' : 'Log session'}
        </button>
      </div>
    </section>
  )
}

export { TodayView }
export type { TodayViewProps }
