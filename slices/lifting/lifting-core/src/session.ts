import { Array as Arr, DateTime } from 'effect'

import type { Prescription } from './prescription.ts'
import { type SetResult, sortByStart } from './set-result.ts'

/**
 * One visit to the gym at one prescription: the sets performed on one calendar
 * `date` in the lifter's zone, earliest first.
 */
interface Session {
  /** The local calendar date, `YYYY-MM-DD` in the zone the sets were grouped in. */
  readonly date: string
  /** The label of the workout the session's first set was part of. */
  readonly workoutLabel: string
  /** The sets performed, earliest first. */
  readonly sets: Arr.NonEmptyReadonlyArray<SetResult>
}

/** The calendar date `instant` falls on in `zone`, as `YYYY-MM-DD`. */
const localDateOf = (instant: DateTime.Utc, zone: DateTime.TimeZone): string =>
  DateTime.formatIsoDate(DateTime.setZone(instant, zone))

/**
 * The sets of one prescription grouped into sessions: every set whose `start`
 * falls on the same calendar date in `zone` is one session.
 *
 * @param sets - The sets logged against one prescription, in any order
 * @param zone - The lifter's time zone, which decides where one day ends and the next begins
 * @returns The sessions earliest first, each with its sets earliest first
 *
 * @remarks
 * A lifter who quits after three sets and finishes the next day has two
 * sessions, each judged on its own by {@link sessionMet}. The zone is a
 * parameter, not a global: the same sets group differently in Toronto and in
 * Tokyo, and this package takes no clock or locale of its own.
 */
const sessionsOf = (sets: readonly SetResult[], zone: DateTime.TimeZone): readonly Session[] =>
  Arr.match(sortByStart(sets), {
    onEmpty: () => [],
    onNonEmpty: (ordered) =>
      Arr.groupWith(
        ordered,
        (left, right) => localDateOf(left.start, zone) === localDateOf(right.start, zone)
      ).map((grouped): Session => ({
        date: localDateOf(Arr.headNonEmpty(grouped).start, zone),
        workoutLabel: Arr.headNonEmpty(grouped).workoutLabel,
        sets: grouped,
      })),
  })

/**
 * Whether a session met its prescription: at least `prescription.sets` sets
 * performed, and each of the first `prescription.sets` reached
 * `prescription.reps`.
 *
 * @remarks
 * Sets past the prescription are extra work and do not count either way.
 */
const sessionMet = (prescription: Prescription, session: Session): boolean =>
  session.sets.length >= prescription.sets &&
  session.sets.slice(0, prescription.sets).every((set) => set.reps >= prescription.reps)

export { localDateOf, sessionMet, sessionsOf }
export type { Session }
