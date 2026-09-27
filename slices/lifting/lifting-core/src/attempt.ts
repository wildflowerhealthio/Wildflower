import { Array as Arr, DateTime, Order } from 'effect'

import type { Exercise } from './plan.ts'

/**
 * One logged performance of one exercise in a session: what was prescribed
 * (`loadLb`, `prescribedSets` × `prescribedReps`) and the reps completed in
 * each set performed.
 *
 * @remarks
 * Whether the attempt succeeded is not stored — it is derived by
 * {@link attemptSucceeded} from `repsCompleted` against the prescription, so a
 * record can never disagree with itself.
 */
interface ExerciseAttempt {
  /** The exercise performed. */
  readonly exercise: Exercise
  /** The label of the workout this attempt was part of. */
  readonly workoutLabel: string
  /** When the exercise was performed. */
  readonly performedAt: DateTime.Utc
  /** The load lifted, in pounds. */
  readonly loadLb: number
  /** Sets prescribed at the time; a positive integer. */
  readonly prescribedSets: number
  /** Reps per set prescribed at the time; a positive integer. */
  readonly prescribedReps: number
  /** Reps completed, one non-negative integer per set performed, in order. */
  readonly repsCompleted: readonly number[]
}

/**
 * Whether an attempt met its prescription: at least `prescribedSets` sets
 * performed, and each of the first `prescribedSets` reached `prescribedReps`.
 *
 * @remarks
 * Sets past the prescription are extra work and do not count either way.
 */
const attemptSucceeded = (attempt: ExerciseAttempt): boolean =>
  attempt.repsCompleted.length >= attempt.prescribedSets &&
  attempt.repsCompleted
    .slice(0, attempt.prescribedSets)
    .every((setReps) => setReps >= attempt.prescribedReps)

/** Oldest first by `performedAt`. */
const byPerformedAt: Order.Order<ExerciseAttempt> = Order.mapInput(
  DateTime.Order,
  (attempt: ExerciseAttempt) => attempt.performedAt
)

/**
 * The attempts oldest first, by `performedAt`.
 *
 * @remarks
 * A stable sort: attempts performed at the same instant keep their input
 * order, so of two such attempts the later one in the input counts as the more
 * recent.
 */
const sortByPerformedAt = (attempts: readonly ExerciseAttempt[]): readonly ExerciseAttempt[] =>
  Arr.sort(attempts, byPerformedAt)

export { attemptSucceeded, sortByPerformedAt }
export type { ExerciseAttempt }
