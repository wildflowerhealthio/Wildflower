import { Array as Arr, Option, pipe } from 'effect'

import type { Plan, PlannedExercise, Workout } from './plan.ts'
import { type SetResult, sortByStart } from './set-result.ts'

/**
 * The workout due next: the one after the most recent set's workout, in the
 * plan's cycle order.
 *
 * @param plan - The plan whose workouts cycle
 * @param sets - Every set logged under the plan, at any exercise, in any order
 * @returns One of `plan.workouts`: the one after the most recent set's
 *   `workoutLabel`, wrapping from the last back to the first
 *
 * @remarks
 * With no sets — or when the most recent set's label names no workout in the
 * plan, as after the plan's workouts were replaced — the cycle starts over at
 * the first workout.
 */
const nextWorkout = (plan: Plan, sets: readonly SetResult[]): Workout =>
  pipe(
    Arr.last(sortByStart(sets)),
    Option.flatMap((latest) =>
      Arr.findFirstIndex(plan.workouts, (workout) => workout.label === latest.workoutLabel)
    ),
    Option.flatMap((index) => Arr.get(plan.workouts, (index + 1) % plan.workouts.length)),
    Option.getOrElse(() => Arr.headNonEmpty(plan.workouts))
  )

/**
 * The exercises a workout runs, one per exercise id in the workout's order —
 * what the "today" screen lists.
 *
 * @param plan - The plan the workout belongs to
 * @param workout - One of `plan.workouts`, e.g. as {@link nextWorkout} returned it
 *
 * @remarks
 * Total: `makePlan` guarantees every exercise a plan's workout names is
 * planned, so no exercise is skipped.
 */
const exercisesFor = (plan: Plan, workout: Workout): Arr.NonEmptyReadonlyArray<PlannedExercise> =>
  Arr.map(workout.exerciseIds, (exerciseId) => plan.exercisesById[exerciseId])

export { exercisesFor, nextWorkout }
