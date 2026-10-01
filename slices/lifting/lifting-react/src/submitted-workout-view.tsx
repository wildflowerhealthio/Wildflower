import { Option } from 'effect'
import {
  ExerciseConcept,
  ExerciseRequest,
  ExerciseSetObservation,
  type PlannedWorkout,
  WorkoutProcedure,
} from 'lifting-core'
import type { JSX } from 'react'
import { useId } from 'react'
import { cn } from 'react-kitchen-sink'
import { ItemList, StatusBadge, type StatusTone } from 'react-tundraish'

import { formatLoad, formatSetReps } from './load-format.ts'
import styles from './submitted-workout-view.module.css'

interface SubmittedWorkoutViewProps {
  /** What `PlannedWorkout.submit` returned for the workout just submitted. */
  readonly submitted: PlannedWorkout.Submitted
}

/** How each decision reads, and the badge tone it wears. */
const DECISION_BADGE_OF: {
  readonly [Decision in ExerciseRequest.Decision]: {
    readonly text: string
    readonly tone: StatusTone
  }
} = {
  increment: { text: 'Increase', tone: 'success' },
  hold: { text: 'Hold', tone: 'neutral' },
  deload: { text: 'Deload', tone: 'warning' },
}

/** The reps of the sets submitted against the `ExerciseRequest`, in order. */
const setRepsAgainst = ({
  exerciseRequest,
  exerciseSetObservations,
}: {
  readonly exerciseRequest: ExerciseRequest.Type
  readonly exerciseSetObservations: readonly ExerciseSetObservation.Type[]
}): readonly number[] =>
  exerciseSetObservations
    .filter(
      (exerciseSetObservation) =>
        ExerciseSetObservation.serviceRequestIdOf(exerciseSetObservation) === exerciseRequest.id
    )
    .map(ExerciseSetObservation.repsOf)

/**
 * The **submitted workout**: what submitting it did to each exercise — the
 * increment / hold / deload decision `PlannedWorkout.submit` made, the load
 * it moves from and to, and the reps entered.
 *
 * @remarks
 * Every decision is `lifting-core`'s, read off each `ExerciseRequest.Progress`:
 * the old load from its `current` `ExerciseRequest`, the new one from its
 * `next`. An exercise with no set entered holds and says so.
 */
const SubmittedWorkoutView = ({ submitted }: SubmittedWorkoutViewProps): JSX.Element => {
  const headingId = useId()
  return (
    <section className={styles['submitted-workout-view']} aria-labelledby={headingId}>
      <h2
        id={headingId}
        className={cn('text-heading-6', styles['submitted-workout-view__heading'])}
      >
        Workout {WorkoutProcedure.dayLabelOf(submitted.workoutProcedure)} done
      </h2>
      <ItemList
        items={submitted.exerciseRequestProgresses.map(({ decision, current, next }) => {
          const setReps = setRepsAgainst({
            exerciseRequest: current,
            exerciseSetObservations: submitted.exerciseSetObservations,
          })
          const load = formatLoad(ExerciseRequest.loadOf(current))
          const badge = DECISION_BADGE_OF[decision]
          return {
            id: current.id,
            title: ExerciseConcept.nameOf(ExerciseRequest.exerciseOf(current)),
            subtitle: [
              Option.match(next, {
                onNone: () => load,
                onSome: (nextExerciseRequest) =>
                  `${load} → ${formatLoad(ExerciseRequest.loadOf(nextExerciseRequest))}`,
              }),
              setReps.length === 0 ? 'No sets entered' : formatSetReps(setReps),
            ].join(' · '),
            badge: <StatusBadge tone={badge.tone}>{badge.text}</StatusBadge>,
          }
        })}
      />
    </section>
  )
}

export { SubmittedWorkoutView }
export type { SubmittedWorkoutViewProps }
