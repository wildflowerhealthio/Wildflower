/**
 * Pure strength-training plans, as the FHIR R4 resources that store them. A
 * {@link Plan} is a `PlanDefinition`: its {@link Workout}s cycle in order,
 * each running {@link PlannedExercise}s — an {@link ExerciseConcept}, sets ×
 * reps, and the {@link ProgressionRule} its load moves by. An
 * {@link ExerciseRequest} is a `ServiceRequest` for one exercise — sets ×
 * reps at one {@link Load}. A {@link WorkoutProcedure} is a `Procedure`: one
 * workout of the plan as the lifter performs it, carrying out the
 * `ExerciseRequest`s it is `basedOn`, and each {@link ExerciseSetObservation}
 * is an `Observation` of one set, `basedOn` its `ExerciseRequest` and
 * `partOf` its workout. `ExerciseRequest.progress` is the increment / hold /
 * deload decision over the completed workouts. {@link StrongLifts5x5} is a
 * template; {@link LiftingMeasure} and {@link LiftingFeature} hold the
 * lifting codes.
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
export { ExerciseSetObservation } from './exercise-set-observation/index.ts'
export { LiftingFeature } from './lifting-feature/index.ts'
export { LiftingMeasure } from './lifting-measure/index.ts'
export { Load } from './load/index.ts'
export { Plan, PlannedExercise, ProgressionRule, Workout } from './plan/index.ts'
export { StrongLifts5x5 } from './plans/index.ts'
export { WorkoutProcedure } from './workout-procedure/index.ts'
