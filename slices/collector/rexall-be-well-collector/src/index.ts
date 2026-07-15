// Rexall Be Well carebook dialect: the concrete STU3 searchset Bundle shapes and
// the carebook extension / identifier / coding-system constants for the Rexall
// tunnel API. Wire payloads decode via the `fhir-stu3-as-r4` schemas — the clean
// STU3 shapes, or straight to R4 through their `R4FromStu3Schema` counterparts.

export * as Carebook from './carebook.ts'
export * as Bundle from './bundle.ts'
