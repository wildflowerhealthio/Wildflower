import { Either } from 'effect'

import * as ExerciseConcept from '../exercise/exercise-concept.ts'
import * as Load from '../load/load.ts'
import * as TrainingPlanDefinition from '../training-plan-definition/training-plan-definition.ts'

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
const pounds = (value: number): Load.Type =>
  Either.getOrThrow(Load.make({ value, unit: '[lb_av]' }))

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
const barbellProgressionRule = (increment: number): TrainingPlanDefinition.ProgressionRule.Type =>
  Either.getOrThrow(
    TrainingPlanDefinition.ProgressionRule.make({
      unit: '[lb_av]',
      increment,
      failuresBeforeDeload: 3,
      deloadFraction: 0.1,
      minimumLoad: 45,
      loadStep: 5,
    })
  )

/**
 * A StrongLifts lift's exercise (definition): `sets` × 5, +10 lb per success
 * for the deadlift and +5 lb for the rest.
 */
const trainingPlanDefinitionExerciseOf = ({
  lift,
  sets,
}: {
  readonly lift: Lift
  readonly sets: number
}): TrainingPlanDefinition.Exercise.Type =>
  Either.getOrThrow(
    TrainingPlanDefinition.Exercise.make({
      exerciseConcept: EXERCISES[lift],
      sets,
      reps: 5,
      progressionRule: barbellProgressionRule(lift === 'deadlift' ? 10 : 5),
    })
  )

/** A StrongLifts day: its label and lifts, each with its sets, in order. */
const trainingPlanDefinitionDayOf = ({
  label,
  lifts,
}: {
  readonly label: string
  readonly lifts: readonly { readonly lift: Lift; readonly sets: number }[]
}): TrainingPlanDefinition.Day.Type =>
  Either.getOrThrow(
    TrainingPlanDefinition.Day.make({
      label,
      trainingPlanDefinitionExercises: lifts.map(trainingPlanDefinitionExerciseOf),
    })
  )

/**
 * The StrongLifts 5×5 program as a training plan definition stored under
 * `planDefinitionId`: day A — squat, bench press, barbell row — and day B —
 * squat, overhead press, deadlift — alternating. Every lift is 5 sets of 5
 * except the deadlift's single set of 5; every lift gains 5 lb per success
 * except the deadlift's 10 lb; three failures at a load deload by 10% in 5 lb
 * steps, never below the empty bar. Starting loads are {@link STARTING_LOADS}.
 *
 * @remarks
 * A template, not a special case: the result is an ordinary training plan
 * definition built by `TrainingPlanDefinition.make`, and nothing else in this
 * package knows StrongLifts exists.
 */
const trainingPlanDefinition = (planDefinitionId: string): TrainingPlanDefinition.Type =>
  Either.getOrThrow(
    TrainingPlanDefinition.make({
      planDefinitionId,
      title: 'StrongLifts 5×5',
      trainingPlanDefinitionDays: [
        trainingPlanDefinitionDayOf({
          label: 'A',
          lifts: [
            { lift: 'squat', sets: 5 },
            { lift: 'bench-press', sets: 5 },
            { lift: 'barbell-row', sets: 5 },
          ],
        }),
        trainingPlanDefinitionDayOf({
          label: 'B',
          lifts: [
            { lift: 'squat', sets: 5 },
            { lift: 'overhead-press', sets: 5 },
            { lift: 'deadlift', sets: 1 },
          ],
        }),
      ],
    })
  )

export { EXERCISES, STARTING_LOADS, trainingPlanDefinition }
export type { Lift }
