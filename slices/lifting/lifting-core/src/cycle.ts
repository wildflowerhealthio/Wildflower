import { Array as Arr, Option, pipe } from 'effect'

import { type ExerciseAttempt, sortByPerformedAt } from './attempt.ts'
import type { ExerciseGoal, Plan, Workout } from './plan.ts'

/**
 * The workout due next: the one after the most recent attempt's workout, in
 * the plan's cycle order.
 *
 * @param plan - The plan whose workouts cycle
 * @param attempts - Every attempt logged against the plan, in any order
 * @returns One of `plan.workouts`: the one after the most recent attempt's
 *   `workoutLabel`, wrapping from the last back to the first
 *
 * @remarks
 * With no attempts — or when the most recent attempt's label names no workout
 * in the plan, as after the plan's workouts were replaced — the cycle starts
 * over at the first workout.
 */
const nextWorkout = (plan: Plan, attempts: readonly ExerciseAttempt[]): Workout =>
  pipe(
    Arr.last(sortByPerformedAt(attempts)),
    Option.flatMap((latest) =>
      Arr.findFirstIndex(plan.workouts, (workout) => workout.label === latest.workoutLabel)
    ),
    Option.flatMap((index) => Arr.get(plan.workouts, (index + 1) % plan.workouts.length)),
    Option.getOrElse(() => Arr.headNonEmpty(plan.workouts))
  )

/**
 * The goals a workout runs, one per exercise id in the workout's order — what
 * the "today" screen lists.
 *
 * @param plan - The plan the workout belongs to
 * @param workout - One of `plan.workouts`, e.g. as {@link nextWorkout} returned it
 *
 * @remarks
 * Total: `makePlan` guarantees every exercise a plan's workout names has a
 * goal, so no exercise is skipped.
 */
const goalsFor = (plan: Plan, workout: Workout): Arr.NonEmptyReadonlyArray<ExerciseGoal> =>
  Arr.map(workout.exerciseIds, (exerciseId) => plan.goalsByExerciseId[exerciseId])

export { goalsFor, nextWorkout }
