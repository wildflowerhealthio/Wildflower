import {
  consecutiveFailures,
  type ExerciseAttempt,
  type ProgressionDecision,
  type Plan,
  progressGoal,
  progressPlan,
} from 'lifting-core'
import type { JSX } from 'react'
import { useId } from 'react'
import { cn } from 'react-kitchen-sink'
import { ErrorBanner, ItemList, StatusBadge, type StatusTone } from 'react-tundraish'

import { formatLoadLb } from './load-format.ts'
import styles from './progression-review.module.css'

interface ProgressionReviewProps {
  /** The plan as last persisted — the loads the session was lifted at. */
  readonly plan: Plan
  /** Every attempt logged against the plan, the session just logged included. */
  readonly attempts: readonly ExerciseAttempt[]
  /** Called with `progressPlan(plan, attempts)` when the person applies the progression. */
  readonly onAccept: (progressedPlan: Plan) => void
  /** The progressed plan is being saved: the action is disabled until it settles. */
  readonly pending?: boolean
  /**
   * Why the last save failed — e.g. a mutation's `error`, passed straight
   * through — shown in an `ErrorBanner`; `null` or absent when it didn't.
   */
  readonly error?: unknown
}

/** How each decision reads, and the badge tone it wears. */
const decisionBadge: { readonly [Decision in ProgressionDecision]: readonly [string, StatusTone] } =
  {
    increment: ['Increase', 'success'],
    hold: ['Hold', 'neutral'],
    deload: ['Deload', 'warning'],
  }

/**
 * The **progression review** after a session: every goal of the plan with the
 * increment / hold / deload decision `lifting-core`'s `progressGoal` made for
 * it and the load it moves from and to, plus one "Apply progression" action.
 *
 * @remarks
 * The action hands `onAccept` exactly `progressPlan(plan, attempts)` — the
 * component decides nothing itself. When every decision is `hold` there is
 * nothing to apply, so the action gives way to a line saying so. A held goal
 * that has failed at its load shows how close it is to a deload
 * (`consecutiveFailures` of `failuresBeforeDeload`).
 */
const ProgressionReview = ({
  plan,
  attempts,
  onAccept,
  pending = false,
  error,
}: ProgressionReviewProps): JSX.Element => {
  const headingId = useId()
  const reviewedGoals = Object.values(plan.goalsByExerciseId).map((goal) => ({
    goal,
    progress: progressGoal(goal, attempts),
  }))
  const anyLoadMoves = reviewedGoals.some(({ progress }) => progress.decision !== 'hold')

  return (
    <section className={styles.review} aria-labelledby={headingId}>
      <h2 id={headingId} className={cn('text-heading-6', styles.heading)}>
        Progression
      </h2>
      <ErrorBanner error={error} />
      <ItemList
        items={reviewedGoals.map(({ goal, progress }) => {
          const [decisionLabel, decisionTone] = decisionBadge[progress.decision]
          const failures = consecutiveFailures(goal, attempts)
          const failureNote =
            failures > 0 ? ` · failed ${failures} of ${goal.progression.failuresBeforeDeload}` : ''
          return {
            id: goal.exercise.id,
            title: goal.exercise.name,
            subtitle:
              progress.decision === 'hold'
                ? `${formatLoadLb(goal.loadLb)}${failureNote}`
                : `${formatLoadLb(goal.loadLb)} → ${formatLoadLb(progress.next.loadLb)}`,
            badge: <StatusBadge tone={decisionTone}>{decisionLabel}</StatusBadge>,
          }
        })}
      />
      <div className={styles.actions}>
        {anyLoadMoves ? (
          <button
            type="button"
            className="button-2 filled"
            disabled={pending}
            onClick={() => {
              onAccept(progressPlan(plan, attempts))
            }}
          >
            {pending ? 'Applying…' : 'Apply progression'}
          </button>
        ) : (
          <p className={cn('text-body-3', styles.nothing)}>
            Every load holds — there is nothing to apply.
          </p>
        )}
      </div>
    </section>
  )
}

export { ProgressionReview }
export type { ProgressionReviewProps }
