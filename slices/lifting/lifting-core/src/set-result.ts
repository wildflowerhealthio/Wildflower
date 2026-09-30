import { Array as Arr, DateTime, Order } from 'effect'

import type { Exercise } from './plan.ts'

/**
 * One set performed against a prescription: the exercise, the workout it was
 * part of, when the set ran (`start` to `end`) and the `reps` completed.
 *
 * @remarks
 * The load is not here: a set is logged against one prescription, and the
 * prescription is the load. Whether a session met its prescription is derived
 * by `sessionMet` from the reps of its sets, never stored.
 */
interface SetResult {
  /** The exercise performed. */
  readonly exercise: Exercise
  /** The label of the workout this set was part of. */
  readonly workoutLabel: string
  /** When the set started. */
  readonly start: DateTime.Utc
  /** When the set ended; not before `start`. */
  readonly end: DateTime.Utc
  /** Reps completed; a non-negative integer. */
  readonly reps: number
}

/** Earliest first by `start`. */
const byStart: Order.Order<SetResult> = Order.mapInput(
  DateTime.Order,
  (set: SetResult) => set.start
)

/**
 * The sets earliest first, by `start`.
 *
 * @remarks
 * A stable sort: sets started at the same instant keep their input order, so
 * of two such sets the later one in the input counts as the more recent.
 */
const sortByStart = (sets: readonly SetResult[]): readonly SetResult[] => Arr.sort(sets, byStart)

export { sortByStart }
export type { SetResult }
