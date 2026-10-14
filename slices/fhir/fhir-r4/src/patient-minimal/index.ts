/*
 * `@wildflowerhealthio/fhir-r4/patient-minimal`: a narrowed `Patient` and the
 * display name of its names, loading nothing but `effect`, for a page that
 * lists patients without the FHIR datatype registry.
 */
export * as PatientMinimal from '../resources/patient/patient-minimal.ts'
export { displayName } from '../data-types/complex/human-name-display.ts'
export type { Displayable } from '../data-types/complex/human-name-display.ts'
