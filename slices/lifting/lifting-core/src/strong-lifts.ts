import { Either } from 'effect'

import {
  type Exercise,
  type ExerciseGoal,
  exerciseIdFromName,
  makePlan,
  type Plan,
  type PlanInput,
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

/**
 * The starting load of each StrongLifts lift, in pounds, as the StrongLifts
 * guide sets them: the empty 45 lb bar for squat, bench press and overhead
 * press; 65 lb for the barbell row; 95 lb for the deadlift.
 */
const STRONGLIFTS_STARTING_LOADS_LB: { readonly [Lift in StrongLiftsLift]: number } = {
  squat: 45,
  'bench-press': 45,
  'barbell-row': 65,
  'overhead-press': 45,
  deadlift: 95,
}

/**
 * The barbell's shared rule parts: three failed sessions at one load take 10%
 * off, in steps of one 2.5 lb plate pair, never below the empty 45 lb bar.
 */
const barbellDeload = {
  failuresBeforeDeload: 3,
  deloadFraction: 0.1,
  minimumLoadLb: 45,
  loadStepLb: 5,
} as const

/** +5 lb per success: every StrongLifts lift but the deadlift. */
const barbellProgression: ProgressionRule = { incrementLb: 5, ...barbellDeload }

/** +10 lb per success: the deadlift, which moves faster. */
const deadliftProgression: ProgressionRule = { incrementLb: 10, ...barbellDeload }

/** A StrongLifts goal: `sets` × 5 at the lift's starting load. */
const goalFor = (
  lift: StrongLiftsLift,
  sets: number,
  progression: ProgressionRule
): ExerciseGoal => ({
  exercise: STRONGLIFTS_EXERCISES[lift],
  loadLb: STRONGLIFTS_STARTING_LOADS_LB[lift],
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
  goals: [
    goalFor('squat', 5, barbellProgression),
    goalFor('bench-press', 5, barbellProgression),
    goalFor('barbell-row', 5, barbellProgression),
    goalFor('overhead-press', 5, barbellProgression),
    goalFor('deadlift', 1, deadliftProgression),
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
 * Loads start at {@link STRONGLIFTS_STARTING_LOADS_LB}.
 *
 * @remarks
 * A template, not a special case: the result is an ordinary plan built by
 * `makePlan`, and nothing else in this package knows StrongLifts exists. The
 * literal is fixed and its tests prove `makePlan` accepts it, so the
 * `getOrThrowWith` here can only fire if the template itself is broken — a defect,
 * not an input error. A caller who wants other starting loads edits the goals
 * and builds its own plan through `makePlan`.
 */
const strongLifts5x5 = (): Plan =>
  Either.getOrThrowWith(makePlan(STRONGLIFTS_5X5_INPUT), (invalid) => invalid)

export {
  STRONGLIFTS_5X5_INPUT,
  STRONGLIFTS_EXERCISES,
  STRONGLIFTS_STARTING_LOADS_LB,
  strongLifts5x5,
}
export type { StrongLiftsLift }
