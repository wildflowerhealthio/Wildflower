/**
 * What WatchLifts tracks: the exercises, the people lifting, and the weight
 * each lifts at each exercise until the settings page changes it.
 *
 * @remarks
 * A namespace module — consumers speak `Lifts.EXERCISES`, `Lifts.PEOPLE`,
 * `Lifts.DEFAULT_WEIGHTS`, `Lifts.MAX_WEIGHT`.
 *
 * These mirror the watch's `s_exercises`, `s_people_names` and default weights
 * in `apps/watch-lifts/watch-lifts-watchapp/src/c/state.c`, in the same order; the app's
 * `test/state.test.ts` holds the two together. The weights are person-major:
 * `weights[person][exercise]`, one row per {@link PEOPLE} entry, one column per
 * {@link EXERCISES} entry. Plain constants with no imports, so the phone's ES5
 * bundle can use them.
 *
 * @packageDocumentation
 */

/** The exercises, in the order the watch lists them. */
const EXERCISES: ReadonlyArray<string> = [
  'Squat',
  'Bench Press',
  'Bent Over Row',
  'Overhead Press',
  'Deadlift',
]

/** The people lifting, in the order the watch shows them. */
const PEOPLE: ReadonlyArray<string> = ['Ruth', 'Chloe']

/** Each person's weight in pounds at each exercise before any are saved: `[person][exercise]`. */
const DEFAULT_WEIGHTS: ReadonlyArray<ReadonlyArray<number>> = [
  [60, 50, 50, 50, 85],
  [65, 55, 55, 45, 85],
]

/**
 * The heaviest weight, in whole pounds, the settings accept: three digits. The
 * watch's `WEIGHTS_WIRE_MAX_WEIGHT` (src/c/weights-wire.h) is the same, and it
 * refuses a message with a heavier one.
 */
const MAX_WEIGHT = 999

export { DEFAULT_WEIGHTS, EXERCISES, MAX_WEIGHT, PEOPLE }
