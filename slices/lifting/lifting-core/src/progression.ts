import { Array as Arr, Option, pipe, Record } from 'effect'

import { attemptSucceeded, type ExerciseAttempt, sortByPerformedAt } from './attempt.ts'
import { brandPlan, type ExerciseGoal, type Plan } from './plan.ts'

/**
 * What a session's attempts do to a goal's load: raise it by the increment,
 * keep it, or cut it by the deload fraction.
 */
type ProgressionDecision = 'increment' | 'hold' | 'deload'

/** The {@link ProgressionDecision} {@link progressGoal} made, and the goal it produced. */
interface GoalProgress {
  /** Which way the load moved. */
  readonly decision: ProgressionDecision
  /** The goal with its load moved; everything but `loadLb` is unchanged. */
  readonly next: ExerciseGoal
}

/**
 * Tolerance for floating-point error when rounding a deloaded load down to a
 * step multiple, so `150 × 0.9` computed as `134.99999…` still lands on 135.
 */
const ROUNDING_TOLERANCE = 1e-9

/** The attempts at the goal's exercise, most recent first. */
const recentFirst = (
  goal: ExerciseGoal,
  attempts: readonly ExerciseAttempt[]
): readonly ExerciseAttempt[] =>
  Arr.reverse(
    sortByPerformedAt(attempts.filter((attempt) => attempt.exercise.id === goal.exercise.id))
  )

/**
 * How many of the goal's most recent attempts in a row failed at its current
 * load — the count a deload waits on ("failure 2 of 3").
 *
 * @param goal - The goal whose exercise and current `loadLb` the run is counted at
 * @param attempts - Attempts in any order; those at other exercises are ignored
 * @returns The length of the trailing run of failed attempts at `goal.loadLb`
 *
 * @remarks
 * The run ends at the most recent attempt that either succeeded or was at a
 * different load, so failures before a deload never count against the
 * deloaded load.
 */
const consecutiveFailures = (goal: ExerciseGoal, attempts: readonly ExerciseAttempt[]): number =>
  pipe(
    recentFirst(goal, attempts),
    Arr.takeWhile((attempt) => attempt.loadLb === goal.loadLb && !attemptSucceeded(attempt))
  ).length

/** `loadLb` rounded down to a multiple of `stepLb`, within {@link ROUNDING_TOLERANCE}. */
const roundDownToStep = (loadLb: number, stepLb: number): number =>
  Math.floor(loadLb / stepLb + ROUNDING_TOLERANCE) * stepLb

/**
 * The load a deload lands on: cut by `deloadFraction`, rounded down to a
 * multiple of `loadStepLb`, and raised back to `minimumLoadLb` if it fell
 * below it.
 *
 * @remarks
 * Rounding down, not to nearest, so a deload never lands above the fraction it
 * promises. The rounded load is also capped at the current load rounded down
 * with no tolerance, so the tolerance can never lift a load that sits a hair
 * under a step multiple.
 */
const deloadedLoadLb = (goal: ExerciseGoal): number => {
  const { deloadFraction, loadStepLb, minimumLoadLb } = goal.progression
  return Math.max(
    minimumLoadLb,
    Math.min(
      roundDownToStep(goal.loadLb * (1 - deloadFraction), loadStepLb),
      Math.floor(goal.loadLb / loadStepLb) * loadStepLb
    )
  )
}

/** The goal at a new load, everything else unchanged. */
const atLoad = (goal: ExerciseGoal, loadLb: number): ExerciseGoal => ({ ...goal, loadLb })

/** The deload step when enough failures have piled up and the deload would lower the load. */
const deloadOf = (
  goal: ExerciseGoal,
  attempts: readonly ExerciseAttempt[]
): Option.Option<GoalProgress> =>
  pipe(
    Option.some(deloadedLoadLb(goal)),
    Option.filter(
      (deloaded) =>
        deloaded < goal.loadLb &&
        consecutiveFailures(goal, attempts) >= goal.progression.failuresBeforeDeload
    ),
    Option.map((deloaded): GoalProgress => ({ decision: 'deload', next: atLoad(goal, deloaded) }))
  )

/**
 * One progression step for one exercise: decide from its attempts whether the
 * load goes up, stays, or deloads, and return the goal at the new load.
 *
 * @param goal - The exercise's current prescription, in the ranges `makePlan` accepts
 * @param attempts - Attempts in any order; those at other exercises are ignored
 * @returns The decision, and the goal it produces
 *
 * @remarks
 * The rule, over the goal's attempts ordered by `performedAt`:
 *
 * - **increment** — the most recent attempt was at `goal.loadLb` and
 *   succeeded (see `attemptSucceeded`): the load rises by exactly
 *   `incrementLb`.
 * - **deload** — otherwise, when {@link consecutiveFailures} at `goal.loadLb`
 *   has reached `failuresBeforeDeload` and the deloaded load (cut by
 *   `deloadFraction`, rounded down to a multiple of `loadStepLb`, never below
 *   `minimumLoadLb`) is lower than the current one.
 * - **hold** — otherwise: no attempts, too few failures, the latest attempt
 *   at another load, or a deload that would not lower a load already at its
 *   floor. The goal is returned unchanged (the same object).
 *
 * Only an attempt at the goal's current load moves it, and every move changes
 * the load, so the step is idempotent: progressing an already-progressed goal
 * against the same attempts holds. It is safe to re-run on every render; a
 * caller persists the result once per session.
 */
const progressGoal = (goal: ExerciseGoal, attempts: readonly ExerciseAttempt[]): GoalProgress =>
  pipe(
    Arr.head(recentFirst(goal, attempts)),
    Option.filter((latest) => latest.loadLb === goal.loadLb && attemptSucceeded(latest)),
    Option.map((): GoalProgress => ({
      decision: 'increment',
      next: atLoad(goal, goal.loadLb + goal.progression.incrementLb),
    })),
    Option.orElse(() => deloadOf(goal, attempts)),
    Option.getOrElse((): GoalProgress => ({ decision: 'hold', next: goal }))
  )

/**
 * Every goal of a plan progressed one step by {@link progressGoal}; title and
 * workouts unchanged.
 *
 * @param plan - The plan as last persisted
 * @param attempts - Every attempt logged against the plan, in any order
 * @returns The plan with each goal's `next`
 */
const progressPlan = (plan: Plan, attempts: readonly ExerciseAttempt[]): Plan =>
  // Rebranded without re-checking: a step changes only `loadLb`, and keeps it
  // in range — an increment adds `incrementLb > 0`, a deload lands on
  // `max(minimumLoadLb, …) < loadLb` — so `loadLb >= minimumLoadLb` and every
  // other `makePlan` invariant still hold. Tests re-check through `makePlan`.
  brandPlan({
    title: plan.title,
    workouts: plan.workouts,
    goalsByExerciseId: Record.map(
      plan.goalsByExerciseId,
      (goal) => progressGoal(goal, attempts).next
    ),
  })

export { consecutiveFailures, progressGoal, progressPlan }
export type { GoalProgress, ProgressionDecision }
