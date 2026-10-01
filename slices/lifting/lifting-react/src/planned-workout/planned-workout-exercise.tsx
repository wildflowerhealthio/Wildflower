import {
  ExerciseConcept,
  ExerciseRequest,
  PlannedWorkout,
  TrainingPlanDefinition,
} from 'lifting-core'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'

import { formatLoad } from '../load-format.ts'
import type { EnteredSetReps } from './entered-set-reps.ts'
import { SetRepsButton } from './set-reps-button.tsx'
import styles from './planned-workout-exercise.module.css'

/** The exercise's name, from its exercise (definition). */
const exerciseNameOf = (plannedWorkoutExercise: PlannedWorkout.Exercise): string =>
  ExerciseConcept.nameOf(
    TrainingPlanDefinition.Exercise.exerciseConceptOf(
      plannedWorkoutExercise.trainingPlanDefinitionExercise
    )
  )

/**
 * One exercise of a planned workout, as a card: its name, load and sets ×
 * reps, "failure N of M" once it has failed at its load, and a
 * {@link SetRepsButton} per set.
 */
const PlannedWorkoutExercise = ({
  plannedWorkoutExercise,
  enteredSetReps,
  pending,
  onTapSet,
}: {
  readonly plannedWorkoutExercise: PlannedWorkout.Exercise
  /** The reps entered for each of its sets so far. */
  readonly enteredSetReps: EnteredSetReps
  /** The workout is being written: the set buttons are disabled. */
  readonly pending: boolean
  /** Called with the index of the set tapped. */
  readonly onTapSet: (setIndex: number) => void
}): JSX.Element => {
  const { exerciseRequest } = plannedWorkoutExercise
  const exerciseName = exerciseNameOf(plannedWorkoutExercise)
  const repsAskedFor = ExerciseRequest.repsOf(exerciseRequest)
  const consecutiveFailures = PlannedWorkout.consecutiveFailuresOf(plannedWorkoutExercise)
  return (
    <li className={styles['planned-workout-exercise']}>
      <div className={styles['planned-workout-exercise__header']}>
        <h3 className={cn('text-body-2', styles['planned-workout-exercise__name'])}>
          {exerciseName}
        </h3>
        <span className="text-body-3">
          {formatLoad(ExerciseRequest.loadOf(exerciseRequest))} ·{' '}
          {ExerciseRequest.setsOf(exerciseRequest)}×{repsAskedFor}
        </span>
      </div>
      {consecutiveFailures > 0 ? (
        <p className={cn('text-body-3', styles['planned-workout-exercise__failures'])}>
          Failure {consecutiveFailures} of{' '}
          {PlannedWorkout.failuresBeforeDeloadOf(plannedWorkoutExercise)} before a deload
        </p>
      ) : null}
      <div
        className={styles['planned-workout-exercise__sets']}
        role="group"
        aria-label={`${exerciseName} sets`}
      >
        {enteredSetReps.map((setReps, setIndex) => (
          <SetRepsButton
            // oxlint-disable-next-line react/no-array-index-key -- sets have no id; set N is always the Nth button
            key={setIndex}
            exerciseName={exerciseName}
            setIndex={setIndex}
            setReps={setReps}
            repsAskedFor={repsAskedFor}
            disabled={pending}
            onTap={() => {
              onTapSet(setIndex)
            }}
          />
        ))}
      </div>
    </li>
  )
}

export { PlannedWorkoutExercise }
