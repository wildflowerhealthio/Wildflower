/**
 * Pure strength-training plans — a lightweight take on HL7's Physical
 * Activity IG (plan → goal → observation). A {@link Plan} holds one
 * {@link ExerciseGoal} per exercise (load, sets × reps, and its
 * {@link ProgressionRule}) and the workouts that cycle in order, checked by
 * {@link makePlan}; an
 * {@link ExerciseAttempt} records one logged performance, whose success is
 * derived, never stored. {@link progressGoal} makes the increment / hold /
 * deload decision, {@link nextWorkout} says which workout is due, and
 * {@link strongLifts5x5} is the StrongLifts 5×5 template. Pounds only. No
 * DOM, no React, no platform imports — the UI renders what this package
 * decides.
 *
 * The FHIR R4 `CarePlan` / `Goal` / `Observation` adapters live behind the
 * `lifting-core/fhir` subpath, so importing the domain from here does not
 * pull in `fhir-r4`'s schemas.
 *
 * @packageDocumentation
 */
export type {
  Exercise,
  ExerciseGoal,
  GoalField,
  Plan,
  PlanInput,
  ProgressionRule,
  Workout,
} from './plan.ts'
export {
  exerciseIdFromName,
  makePlan,
  outOfRangeFieldsOf,
  PlanInvalid,
  PlanProblem,
} from './plan.ts'

export type { ExerciseAttempt } from './attempt.ts'
export { attemptSucceeded, sortByPerformedAt } from './attempt.ts'

export type { GoalProgress, ProgressionDecision } from './progression.ts'
export { consecutiveFailures, progressGoal, progressPlan } from './progression.ts'

export { goalsFor, nextWorkout } from './cycle.ts'

export type { StrongLiftsLift } from './strong-lifts.ts'
export {
  STRONGLIFTS_5X5_INPUT,
  STRONGLIFTS_EXERCISES,
  STRONGLIFTS_STARTING_LOADS_LB,
  strongLifts5x5,
} from './strong-lifts.ts'
