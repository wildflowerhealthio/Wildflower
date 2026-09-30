/**
 * Pure strength-training plans. A {@link Plan} is the program: one
 * {@link PlannedExercise} per exercise (sets × reps and its
 * {@link ProgressionRule}) and the workouts that cycle in order, checked by
 * {@link makePlan}. A {@link Prescription} is the lifter's state at one
 * exercise — sets × reps at one {@link Load} — made by {@link prescribe} and
 * moved by {@link progressPrescription}, the increment / hold / deload
 * decision over the {@link SetResult}s logged against it, grouped into
 * {@link Session}s by calendar day. {@link nextWorkout} says which workout is
 * due, and {@link strongLifts5x5} is the StrongLifts 5×5 template. No DOM, no
 * React, no platform imports, no clock of its own — the UI renders what this
 * package decides.
 *
 * The FHIR R4 `PlanDefinition` / `ServiceRequest` / `Observation` adapters
 * live behind the `lifting-core/fhir` subpath, so importing the domain from
 * here does not pull in `fhir-r4`'s schemas.
 *
 * @packageDocumentation
 */
export type {
  Exercise,
  Load,
  LoadUnit,
  Plan,
  PlanInput,
  PlannedExercise,
  PlannedExerciseField,
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

export type { Prescription, PrescriptionField } from './prescription.ts'
export {
  outOfRangePrescriptionFieldsOf,
  prescribe,
  prescriptionFor,
  PrescriptionProblem,
  PrescriptionRefused,
} from './prescription.ts'

export type { SetResult } from './set-result.ts'
export { sortByStart } from './set-result.ts'

export type { Session } from './session.ts'
export { sessionMet, sessionsOf } from './session.ts'

export type { LoadUnitMismatch, PrescriptionProgress, ProgressionDecision } from './progression.ts'
export { consecutiveFailures, progressPrescription } from './progression.ts'

export { exercisesFor, nextWorkout } from './cycle.ts'

export type { StrongLiftsLift } from './strong-lifts.ts'
export {
  STRONGLIFTS_5X5_INPUT,
  STRONGLIFTS_EXERCISES,
  STRONGLIFTS_STARTING_LOADS,
  strongLifts5x5,
} from './strong-lifts.ts'
