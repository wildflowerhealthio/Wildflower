export { FhirResourceSchema } from './fhir-resource.ts'
export type { FhirResource } from './fhir-resource.ts'
export * as DateSearchParam from './search/date-search-param.ts'
export { SUBJECT_RESOURCE_TYPES, withSubject } from './with-subject.ts'
export * from './binary/index.ts'
export * from './care-plan/index.ts'
export * from './diagnostic-report/index.ts'
export * from './document-reference/index.ts'
export * from './goal/index.ts'
export * from './imaging-study/index.ts'
export * from './medication/index.ts'
export * from './medication-dispense/index.ts'
export * from './medication-request/index.ts'
export * from './observation/index.ts'
export * from './patient/index.ts'
export * from './plan-definition/index.ts'
export * from './practitioner/index.ts'
export * from './procedure/index.ts'
export * from './service-request/index.ts'

// Named decoded interfaces, re-exported at the top level so a downstream
// package whose inferred types embed them can name them in its generated
// declarations (TS2883 — see `fhir-r4/docs/Consumer Gotchas Reference.md`).
export type { Type as PlanDefinitionActionType } from './plan-definition/plan-definition-action.ts'
