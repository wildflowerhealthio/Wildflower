// STU3 wire schemas that decode straight to the fhir-r4 slice's decoded resource
// types. Each `*` namespace re-export exposes the clean STU3 `Schema` plus an
// `R4FromStu3Schema` — an Effect schema transform whose decoded output is the R4
// resource, and whose encode fails when an R4 value falls outside the
// STU3-representable subset. `Bundle` is the generic searchset factory.

export * as Medication from './medication.ts'
export * as MedicationRequest from './medication-request.ts'
export * as MedicationDispense from './medication-dispense.ts'
export * as Bundle from './bundle.ts'
