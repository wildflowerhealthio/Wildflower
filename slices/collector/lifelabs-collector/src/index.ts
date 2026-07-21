// LifeLabs collector. The full collector surface for `collector-registry` to
// assemble: the `LifeLabsCollectorDescriptor` (config, captcha-aware scraping
// plan, persist sink, display), the `AnalyticSummaryEntity` that synthesizes an
// R4 Patient plus Observations from MyCareCompass's bespoke `GetAnalyticSummary`
// payload, and the `LifeLabsConfigForm` `collector-react` registers.
//
// Unlike `rexall-be-well-collector`, there is no STU3/carebook dialect layer:
// the LifeLabs payload is bespoke JSON synthesized straight to R4, so this
// package depends on `fhir-r4` (not `fhir-stu3-as-r4`).

export * from './config.ts'
export * from './persist.ts'
export * from './lifelabs-config-form.tsx'
export * from './entities/analytic-summary-entity.ts'
