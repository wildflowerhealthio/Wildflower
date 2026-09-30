/**
 * Pure strength-training plans, as the FHIR R4 resources that store them. A
 * {@link Plan} is a `PlanDefinition`: its {@link Workout}s cycle in order,
 * each running {@link PlannedExercise}s — an {@link ExerciseConcept}, sets ×
 * reps, and the {@link ProgressionRule} its load moves by. An
 * {@link ExerciseRequest} is a `ServiceRequest` for one exercise — sets × reps
 * at one {@link Load} — made from a plan and moved by
 * `ExerciseRequest.progress`, the increment / hold / deload decision over the
 * {@link ExerciseSetObservation}s (`Observation`s) logged against it, grouped
 * into a {@link Session} per calendar day. {@link StrongLifts5x5} is a
 * template.
 *
 * Each concept is a namespace: a `Schema` narrowing the decoded `fhir-r4`
 * type, the `Type` it decodes to, a `make` that builds one, and getters for
 * what it holds. No DOM, no React, no platform imports, no clock of its own —
 * the UI renders what this package decides.
 *
 * @packageDocumentation
 */
export { ExerciseConcept } from './exercise/index.ts'
export { ExerciseRequest } from './exercise-request/index.ts'
export { ExerciseSetObservation, Session } from './exercise-set-observation/index.ts'
export { LiftingMeasureCode } from './lifting-measure/lifting-measure.ts'
export { Load } from './load/index.ts'
export { Plan, PlannedExercise, ProgressionRule, Workout } from './plan/index.ts'
export { StrongLifts5x5 } from './plans/index.ts'
export { LIFTING_FEATURE_TOKEN } from './terminology.ts'
