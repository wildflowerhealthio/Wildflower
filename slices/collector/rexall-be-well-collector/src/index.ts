// Rexall Be Well collector. Two layers, both exported from here:
//
//  - The carebook STU3 dialect (`Carebook` constants, `Bundle` shapes): the
//    concrete searchset Bundle schemas and extension/identifier/coding-system
//    URLs for the Rexall tunnel API. Wire payloads decode via the
//    `fhir-stu3-as-r4` schemas — clean STU3, or straight to R4 through their
//    `R4FromStu3Schema` counterparts.
//  - The full collector surface: the `RexallCollectorDescriptor` (config,
//    scraping plan, persist sink, display) `collector-registry` assembles, the
//    profile/medication-list entities it recognizes, and the `RexallConfigForm`
//    `collector-react` registers.

export * as Carebook from './carebook.ts'
export * as Bundle from './bundle.ts'

export * from './config.ts'
export * from './rexall-config-form.tsx'
export * from './entities/profile-entity.ts'
export * from './entities/medication-list-entity.ts'
export * from './provenance.ts'
