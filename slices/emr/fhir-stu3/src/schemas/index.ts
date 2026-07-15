// Carebook STU3 dialect wire schemas. Each `*` namespace re-export exposes a
// `Schema` member that decodes the observed carebook payload shape; `carebook`
// carries the dialect's extension/identifier/coding system constants.

export * as Carebook from './carebook.ts'
export * as Medication from './medication.ts'
export * as MedicationRequest from './medication-request.ts'
export * as MedicationDispense from './medication-dispense.ts'
export * as Bundle from './bundle.ts'
