import { Array as Arr, DateTime, Option, pipe, Record as Rec } from 'effect'
import { attemptSucceeded, type ExerciseAttempt, type Plan, sortByPerformedAt } from 'lifting-core'
import type { JSX } from 'react'
import { useId } from 'react'
import { cn } from 'react-kitchen-sink'
import { ItemList, StatusBadge } from 'react-tundraish'

import { formatLoadLb, formatRepsCompleted } from './load-format.ts'
import styles from './history-view.module.css'

interface HistoryViewProps {
  /** The plan the attempts were logged against; names each attempt's exercise. */
  readonly plan: Plan
  /** Every attempt logged, in any order. */
  readonly attempts: readonly ExerciseAttempt[]
}

/**
 * A formatter for a local calendar day as a heading, e.g.
 * `"Sat, Sep 26, 2026"`. Made per render: an `Intl.DateTimeFormat` fixes the
 * zone it was made in, and the viewer's zone is read at render time.
 */
const dayHeadingFormat = (): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

/** A month or day number as two digits, e.g. `"09"`. */
const twoDigits = (value: number): string => String(value).padStart(2, '0')

/**
 * The viewer's **local** calendar day (`YYYY-MM-DD`) an instant falls on.
 *
 * @remarks
 * Mirrors `medication-calendar-react`'s `localCalendarDay`: `performedAt` is a
 * UTC instant, so an evening session in a UTC-negative zone has already
 * reached the next UTC day, yet the person lifted on the local one. Local time
 * is read here in the UI layer, never in `lifting-core`.
 */
const localCalendarDay = (instant: DateTime.Utc): string => {
  const date = DateTime.toDateUtc(instant)
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`
}

/**
 * The **session history**: every logged attempt, grouped by the viewer's
 * local calendar day it was performed on, newest day first and newest attempt
 * first within a day. Each row shows the exercise, its workout, the load, the
 * reps per set, and a success / failed badge from `lifting-core`'s
 * `attemptSucceeded`.
 *
 * @remarks
 * Each attempt goes by its exercise's current name in `plan`, so a renamed
 * lift reads the same across its history; an attempt at an exercise the plan
 * no longer has is still listed, under the name it was logged with — history
 * is never hidden because the plan moved on. With no attempts the view says
 * so.
 */
const HistoryView = ({ plan, attempts }: HistoryViewProps): JSX.Element => {
  const headingId = useId()
  const dayHeading = dayHeadingFormat()
  const attemptsByDay = pipe(
    Arr.reverse(sortByPerformedAt(attempts)),
    Arr.groupBy((attempt) => localCalendarDay(attempt.performedAt))
  )
  // The plan's current name, so a renamed lift reads the same across its
  // history; an exercise the plan no longer has keeps the name it was logged under.
  const exerciseName = (attempt: ExerciseAttempt): string =>
    pipe(
      Rec.get(plan.goalsByExerciseId, attempt.exercise.id),
      Option.match({ onNone: () => attempt.exercise.name, onSome: (goal) => goal.exercise.name })
    )

  return (
    <section className={styles.history} aria-labelledby={headingId}>
      <h2 id={headingId} className={cn('text-heading-6', styles.heading)}>
        History
      </h2>
      {attempts.length === 0 ? (
        <p className={cn('text-body-2', styles.empty)}>
          No sessions logged yet. Log one from Today and it will show up here.
        </p>
      ) : (
        Object.entries(attemptsByDay).map(([day, dayAttempts]) => (
          <ItemList
            key={day}
            title={dayHeading.format(DateTime.toDateUtc(Arr.headNonEmpty(dayAttempts).performedAt))}
            items={dayAttempts.map((attempt, index) => {
              const succeeded = attemptSucceeded(attempt)
              return {
                id: `${DateTime.toEpochMillis(attempt.performedAt)}/${attempt.exercise.id}/${index}`,
                title: exerciseName(attempt),
                subtitle: `Workout ${attempt.workoutLabel} · ${formatLoadLb(attempt.loadLb)} · ${formatRepsCompleted(attempt.repsCompleted)}`,
                badge: (
                  <StatusBadge tone={succeeded ? 'success' : 'danger'}>
                    {succeeded ? 'Success' : 'Failed'}
                  </StatusBadge>
                ),
              }
            })}
          />
        ))
      )}
    </section>
  )
}

export { HistoryView }
export type { HistoryViewProps }
