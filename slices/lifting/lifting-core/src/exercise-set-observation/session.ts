import { Array as Arr, DateTime } from 'effect'

import * as ExerciseSetObservation from './exercise-set-observation.ts'

/**
 * One visit to the gym at one `ExerciseRequest`: the sets performed on one
 * calendar `date` in the lifter's zone, earliest first.
 */
interface Type {
  /** The local calendar date, `YYYY-MM-DD` in the zone the sets were grouped in. */
  readonly date: string
  /** The label of the workout the session's first set was part of. */
  readonly workoutLabel: string
  /** The set observations, earliest first. */
  readonly setObservations: Arr.NonEmptyReadonlyArray<ExerciseSetObservation.Type>
}

/** The calendar date `instant` falls on in `zone`, as `YYYY-MM-DD`. */
const localDateOf = (instant: DateTime.Utc, zone: DateTime.TimeZone): string =>
  DateTime.formatIsoDate(DateTime.setZone(instant, zone))

/**
 * The sets of one `ExerciseRequest` grouped into sessions: every set whose
 * start falls on the same calendar date in `zone` is one session.
 *
 * @param setObservations - The sets logged against one `ExerciseRequest`, in any order
 * @param zone - The lifter's time zone, which decides where one day ends and the next begins
 * @returns The sessions earliest first, each with its sets earliest first
 *
 * @remarks
 * A lifter who quits after three sets and finishes the next day has two
 * sessions, each judged on its own by `ExerciseRequest.isMetBy`. The zone is
 * a parameter, not a global: the same sets group differently in Toronto and
 * in Tokyo, and this package takes no clock or locale of its own.
 */
const groupByDate = (
  setObservations: readonly ExerciseSetObservation.Type[],
  zone: DateTime.TimeZone
): readonly Type[] =>
  Arr.match(ExerciseSetObservation.sortByStart(setObservations), {
    onEmpty: () => [],
    onNonEmpty: (ordered) =>
      Arr.groupWith(
        ordered,
        (left, right) =>
          localDateOf(ExerciseSetObservation.startOf(left), zone) ===
          localDateOf(ExerciseSetObservation.startOf(right), zone)
      ).map((grouped): Type => ({
        date: localDateOf(ExerciseSetObservation.startOf(Arr.headNonEmpty(grouped)), zone),
        workoutLabel: ExerciseSetObservation.workoutLabelOf(Arr.headNonEmpty(grouped)),
        setObservations: grouped,
      })),
  })

export { groupByDate, localDateOf }
export type { Type }
