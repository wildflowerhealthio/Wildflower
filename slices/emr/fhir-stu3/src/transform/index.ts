// STU3 (carebook dialect) → fhir-r4 transforms. Each function takes a decoded
// STU3 dialect resource and produces the fhir-r4 slice's decoded resource type,
// preserving carebook extensions verbatim so no source data is dropped.

export { transformMedicationRequest, transformDispenseRequest } from './medication-request.ts'
export { transformMedicationDispense } from './medication-dispense.ts'
