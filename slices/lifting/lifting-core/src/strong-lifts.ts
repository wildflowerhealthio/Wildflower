import { Either } from 'effect'

import {
  type Exercise,
  exerciseIdFromName,
  type Load,
  makePlan,
  type Plan,
  type PlanInput,
  type PlannedExercise,
  type ProgressionRule,
} from './plan.ts'

/** The five lifts StrongLifts 5×5 is built from, by {@link Exercise.id}. */
type StrongLiftsLift = 'squat' | 'bench-press' | 'barbell-row' | 'overhead-press' | 'deadlift'

/** A StrongLifts lift from its display name, its id slugged by {@link exerciseIdFromName}. */
const liftNamed = (name: string): Exercise => ({ id: exerciseIdFromName(name), name })

/**
 * Each StrongLifts lift as an {@link Exercise}, its id slugged from its name
 * by {@link exerciseIdFromName}.
 */
const STRONGLIFTS_EXERCISES: { readonly [Lift in StrongLiftsLift]: Exercise } = {
  squat: liftNamed('Squat'),
  'bench-press': liftNamed('Bench Press'),
  'barbell-row': liftNamed('Barbell Row'),
  'overhead-press': liftNamed('Overhead Press'),
  deadlift: liftNamed('Deadlift'),
}

/** A load in pounds. */
const pounds = (value: number): Load => ({ value, unit: 'lb' })

/**
 * The starting load of each StrongLifts lift, as the StrongLifts guide sets
 * them in pounds: the empty 45 lb bar for squat, bench press and overhead
 * press; 65 lb for the barbell row; 95 lb for the deadlift.
 *
 * @remarks
 * A lifter's first prescriptions: `prescribe(strongLifts5x5(), lift, load)`
 * for each entry. A lifter starting elsewhere prescribes their own loads.
 */
const STRONGLIFTS_STARTING_LOADS: { readonly [Lift in StrongLiftsLift]: Load } = {
  squat: pounds(45),
  'bench-press': pounds(45),
  'barbell-row': pounds(65),
  'overhead-press': pounds(45),
  deadlift: pounds(95),
}

/**
 * The barbell's shared rule parts, in pounds: three failed sessions at one
 * load take 10% off, in steps of one 2.5 lb plate pair, never below the empty
 * 45 lb bar.
 */
const barbellDeload = {
  unit: 'lb',
  failuresBeforeDeload: 3,
  deloadFraction: 0.1,
  minimumLoad: 45,
  loadStep: 5,
} as const

/** +5 lb per success: every StrongLifts lift but the deadlift. */
const barbellProgression: ProgressionRule = { increment: 5, ...barbellDeload }

/** +10 lb per success: the deadlift, which moves faster. */
const deadliftProgression: ProgressionRule = { increment: 10, ...barbellDeload }

/** A StrongLifts lift as planned: `sets` × 5. */
const plannedLift = (
  lift: StrongLiftsLift,
  sets: number,
  progression: ProgressionRule
): PlannedExercise => ({
  exercise: STRONGLIFTS_EXERCISES[lift],
  sets,
  reps: 5,
  progression,
})

/**
 * The StrongLifts 5×5 template as `makePlan` input — exported so its tests
 * validate the very literal {@link strongLifts5x5} is built from.
 */
const STRONGLIFTS_5X5_INPUT: PlanInput = {
  title: 'StrongLifts 5×5',
  exercises: [
    plannedLift('squat', 5, barbellProgression),
    plannedLift('bench-press', 5, barbellProgression),
    plannedLift('barbell-row', 5, barbellProgression),
    plannedLift('overhead-press', 5, barbellProgression),
    plannedLift('deadlift', 1, deadliftProgression),
  ],
  workouts: [
    {
      label: 'A',
      exerciseIds: [
        STRONGLIFTS_EXERCISES.squat.id,
        STRONGLIFTS_EXERCISES['bench-press'].id,
        STRONGLIFTS_EXERCISES['barbell-row'].id,
      ],
    },
    {
      label: 'B',
      exerciseIds: [
        STRONGLIFTS_EXERCISES.squat.id,
        STRONGLIFTS_EXERCISES['overhead-press'].id,
        STRONGLIFTS_EXERCISES.deadlift.id,
      ],
    },
  ],
}

/**
 * The StrongLifts 5×5 program as a {@link Plan}: workout A — squat, bench
 * press, barbell row — and workout B — squat, overhead press, deadlift —
 * alternating. Every lift is 5 sets of 5 except the deadlift's single set of
 * 5; every lift gains 5 lb per success except the deadlift's 10 lb; three
 * failures at a load deload by 10% in 5 lb steps, never below the empty bar.
 * Starting loads are {@link STRONGLIFTS_STARTING_LOADS}.
 *
 * @remarks
 * A template, not a special case: the result is an ordinary plan built by
 * `makePlan`, and nothing else in this package knows StrongLifts exists. The
 * literal is fixed and its tests prove `makePlan` accepts it, so the
 * `getOrThrowWith` here can only fire if the template itself is broken — a defect,
 * not an input error.
 */
const strongLifts5x5 = (): Plan =>
  Either.getOrThrowWith(makePlan(STRONGLIFTS_5X5_INPUT), (invalid) => invalid)

export { STRONGLIFTS_5X5_INPUT, STRONGLIFTS_EXERCISES, STRONGLIFTS_STARTING_LOADS, strongLifts5x5 }
export type { StrongLiftsLift }
