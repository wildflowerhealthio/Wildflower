/**
 * The FHIR R4 adapters for strength-training plans: a `Plan` as a
 * `PlanDefinition` ({@link planToFhir} / {@link planFromFhir}), a
 * `Prescription` as a `ServiceRequest` ({@link prescriptionToFhir} /
 * {@link prescriptionFromFhir}) and a `SetResult` as an `Observation`
 * ({@link setResultToFhir} / {@link setResultFromFhir}).
 *
 * Reading back what a writer wrote gives back the same value, with the ids
 * the app needs: a plan comes back as a `StoredPlan` (its `PlanDefinition`
 * id and canonical `url`), a prescription as a `StoredPrescription` (its
 * `ServiceRequest` id, the plan url it instantiates and its status), and a
 * set as a `StoredSetResult` (the request it is `basedOn`).
 * {@link prescriptionProgressToFhir} turns a progression step into the
 * resources to write — the current request closed, the next one issued in
 * its place — and {@link revokedRequest} closes a request on a change of
 * program. No reader throws: each returns its value or a tagged error listing
 * every problem, and a retracted observation reads as `None`, not as a
 * failure.
 *
 * Kept behind the `lifting-core/fhir` subpath so importing the domain from
 * `lifting-core` does not pull in `fhir-r4`'s schemas.
 *
 * @packageDocumentation
 */
export type { LiftingMeasure, LiftingProgressionPartName } from './elements.ts'
export {
  LIFTING_FEATURE_TOKEN,
  LiftingMeasureCode,
  LiftingProgressionPart,
  planUrlOf,
} from './elements.ts'

export type { PlanDefinitionResource, PlanToFhirOptions, StoredPlan } from './plan.ts'
export {
  ExerciseActionProblem,
  planFromFhir,
  PlanReadProblem,
  planToFhir,
  PlanUnreadable,
  storedPlanAt,
} from './plan.ts'

export type {
  PrescriptionToFhirOptions,
  ProgressResources,
  ProgressToFhirOptions,
  RequestStatus,
  ServiceRequestResource,
  StoredPrescription,
} from './prescription.ts'
export {
  prescriptionFromFhir,
  prescriptionProgressToFhir,
  PrescriptionReadProblem,
  prescriptionToFhir,
  PrescriptionUnreadable,
  revokedRequest,
} from './prescription.ts'

export type { ObservationResource, SetResultToFhirOptions, StoredSetResult } from './set-result.ts'
export { SetReadProblem, setResultFromFhir, setResultToFhir, SetUnreadable } from './set-result.ts'
