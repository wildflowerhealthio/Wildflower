import type { PlannedWorkout } from '@wildflowerhealthio/lifting-core-js'
import { TrainingPlanDefinition } from '@wildflowerhealthio/lifting-core-js'
import type { JSX } from 'react'

import { PlannedWorkoutForm, type PlannedWorkoutFormProps } from './planned-workout-form.tsx'

/** {@link PlannedWorkoutView}'s props: those of the form it shows for the workout due. */
type PlannedWorkoutViewProps = PlannedWorkoutFormProps

/**
 * Identifies one planned workout: its day, and per exercise the
 * `ExerciseRequest` worked at and how many attempts it has — so a workout
 * submitted and planned again (even the same day at the same loads) starts
 * with nothing entered.
 */
const plannedWorkoutKeyOf = (plannedWorkout: PlannedWorkout.Type): string =>
  [
    TrainingPlanDefinition.Day.labelOf(plannedWorkout.trainingPlanDefinitionDay),
    ...plannedWorkout.plannedWorkoutExercises.map(
      ({ exerciseRequest, attempts }) => `${exerciseRequest.id}#${attempts.length}`
    ),
  ].join('|')

/**
 * The **planned workout**: the day due, and each of its exercises with its
 * load, sets × reps, how many failures in a row it has toward a deload, and a
 * button per set to enter the reps done.
 *
 * @remarks
 * Every value comes from `lifting-core-js`: the day and exercises from the
 * `PlannedWorkout`, the load and sets × reps from its `ExerciseRequest`, and
 * "failure N of M" from `PlannedWorkout.consecutiveFailuresOf` and
 * `failuresBeforeDeloadOf` (shown once N is above 0).
 *
 * Each set button starts not done. A tap enters the reps asked for, each
 * further tap takes one off, and a tap at 0 makes the set not done again —
 * one thumb per set, no keyboard. "Submit workout" hands `onSubmit` the
 * entered sets of each exercise in set order (a set not done is left out, so
 * an exercise with none is no attempt and holds), with the workout's span;
 * it is enabled once a set is entered.
 *
 * What is entered resets when another workout is planned (see
 * {@link plannedWorkoutKeyOf}).
 */
const PlannedWorkoutView = (props: PlannedWorkoutViewProps): JSX.Element => (
  <PlannedWorkoutForm key={plannedWorkoutKeyOf(props.plannedWorkout)} {...props} />
)

export { PlannedWorkoutView }
export type { WorkoutSubmission } from './workout-submission.ts'
export type { PlannedWorkoutViewProps }
