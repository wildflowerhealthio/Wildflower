import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { Option } from 'effect'
import type { JSX } from 'react'

import styles from './set-reps-button.module.css'

/**
 * One set of a planned exercise as a round button: blank while not done, the
 * reps entered once it is, and tinted when they fall short of the reps asked
 * for. Its label reads the set's state, e.g. `"Squat set 2: 4 of 5 reps"`.
 */
const SetRepsButton = ({
  exerciseName,
  setIndex,
  setReps,
  repsAskedFor,
  disabled,
  onTap,
}: {
  readonly exerciseName: string
  /** The set's 0-based index; its label counts from 1. */
  readonly setIndex: number
  /** The reps entered for the set; `None` while it is not done. */
  readonly setReps: Option.Option<number>
  readonly repsAskedFor: number
  readonly disabled: boolean
  readonly onTap: () => void
}): JSX.Element => (
  <button
    type="button"
    className={cn(
      styles['set-reps-button'],
      Option.match(setReps, {
        onNone: () => styles['set-reps-button--not-done'],
        onSome: (reps) => (reps < repsAskedFor ? styles['set-reps-button--short'] : null),
      }),
      'text-body-2'
    )}
    aria-label={Option.match(setReps, {
      onNone: () => `${exerciseName} set ${setIndex + 1}: not done`,
      onSome: (reps) => `${exerciseName} set ${setIndex + 1}: ${reps} of ${repsAskedFor} reps`,
    })}
    disabled={disabled}
    onClick={onTap}
  >
    {Option.getOrElse(Option.map(setReps, String), () => '')}
  </button>
)

export { SetRepsButton }
