import { Option } from 'effect'

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

export { setRepsAfterTap }
export type { EnteredSetReps }
