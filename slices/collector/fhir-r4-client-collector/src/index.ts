// The FHIR R4 collector surface: the `FhirR4CollectorDescriptor` (config,
// scraping plan, persist sink, display) `collector-registry` assembles, and the
// `FhirR4ConfigForm` `collector-react` registers.
//
// The entities the plan decodes with — and the offline surface an archive
// importer replays — live in `fhir-r4-source` (slices/http-extraction), the shared
// importer project this package builds its live plan from.

export * from './config.ts'
export * from './fhir-r4-config-form.tsx'
