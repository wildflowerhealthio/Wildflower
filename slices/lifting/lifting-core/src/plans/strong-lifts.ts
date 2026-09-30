import { Either } from 'effect'

import * as ExerciseConcept from '../exercise/exercise-concept.ts'
import * as Load from '../load/load.ts'
import * as Plan from '../plan/plan.ts'
import * as PlannedExercise from '../plan/planned-exercise.ts'
import * as ProgressionRule from '../plan/progression-rule.ts'
import * as Workout from '../plan/workout.ts'

// Every `Either.getOrThrow` here unwraps a make over a fixed literal that the
// tests prove each make accepts, so it can only fire if the template itself
// is broken — a defect, not an input error.

/** The five lifts StrongLifts 5×5 is built from, by exercise id. */
type Lift = 'squat' | 'bench-press' | 'barbell-row' | 'overhead-press' | 'deadlift'

/** A StrongLifts lift from its display name, its id slugged by `ExerciseConcept.idFromName`. */
const liftNamed = (name: string): ExerciseConcept.Type =>
  Either.getOrThrow(ExerciseConcept.make({ id: ExerciseConcept.idFromName(name), name }))

/** Each StrongLifts lift as an exercise, its id slugged from its name. */
const EXERCISES: { readonly [L in Lift]: ExerciseConcept.Type } = {
  squat: liftNamed('Squat'),
  'bench-press': liftNamed('Bench Press'),
  'barbell-row': liftNamed('Barbell Row'),
  'overhead-press': liftNamed('Overhead Press'),
  deadlift: liftNamed('Deadlift'),
}

/** A load in pounds. */
const pounds = (value: number): Load.Type => Either.getOrThrow(Load.make({ value, unit: 'lb' }))

/**
 * The starting load of each StrongLifts lift, as the StrongLifts guide sets
 * them in pounds: the empty 45 lb bar for squat, bench press and overhead
 * press; 65 lb for the barbell row; 95 lb for the deadlift.
 *
 * @remarks
 * A lifter's first `ExerciseRequest`s: `ExerciseRequest.make` at each entry's
 * lift and load. A lifter starting elsewhere starts at their own loads.
 */
const STARTING_LOADS: { readonly [L in Lift]: Load.Type } = {
  squat: pounds(45),
  'bench-press': pounds(45),
  'barbell-row': pounds(65),
  'overhead-press': pounds(45),
  deadlift: pounds(95),
}

/**
 * The barbell rule in pounds, gaining `increment` per success: three failed
 * workouts at one load take 10% off, in steps of one 2.5 lb plate pair, never
 * below the empty 45 lb bar.
 */
const barbellRule = (increment: number): ProgressionRule.Type =>
  Either.getOrThrow(
    ProgressionRule.make({
      unit: 'lb',
      increment,
      failuresBeforeDeload: 3,
      deloadFraction: 0.1,
      minimumLoad: 45,
      loadStep: 5,
    })
  )

/** A StrongLifts lift as planned: `sets` × 5, +10 lb per success for the deadlift and +5 lb for the rest. */
const plannedLift = (lift: Lift, sets: number): PlannedExercise.Type =>
  Either.getOrThrow(
    PlannedExercise.make({
      exercise: EXERCISES[lift],
      sets,
      reps: 5,
      progressionRule: barbellRule(lift === 'deadlift' ? 10 : 5),
    })
  )

/** A StrongLifts workout: its label and lifts, in order. */
const workout = (label: string, lifts: readonly (readonly [Lift, number])[]): Workout.Type =>
  Either.getOrThrow(
    Workout.make({ label, plannedExercises: lifts.map(([lift, sets]) => plannedLift(lift, sets)) })
  )

/**
 * The StrongLifts 5×5 program as a plan stored under `planDefinitionId`:
 * workout A — squat, bench press, barbell row — and workout B — squat,
 * overhead press, deadlift — alternating. Every lift is 5 sets of 5 except
 * the deadlift's single set of 5; every lift gains 5 lb per success except the
 * deadlift's 10 lb; three failures at a load deload by 10% in 5 lb steps,
 * never below the empty bar. Starting loads are {@link STARTING_LOADS}.
 *
 * @remarks
 * A template, not a special case: the result is an ordinary plan built by
 * `Plan.make`, and nothing else in this package knows StrongLifts exists.
 */
const plan = (planDefinitionId: string): Plan.Type =>
  Either.getOrThrow(
    Plan.make({
      planDefinitionId,
      title: 'StrongLifts 5×5',
      workouts: [
        workout('A', [
          ['squat', 5],
          ['bench-press', 5],
          ['barbell-row', 5],
        ]),
        workout('B', [
          ['squat', 5],
          ['overhead-press', 5],
          ['deadlift', 1],
        ]),
      ],
    })
  )

export { EXERCISES, plan, STARTING_LOADS }
export type { Lift }
