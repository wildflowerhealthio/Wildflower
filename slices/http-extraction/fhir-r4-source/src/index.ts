/**
 * The FHIR R4 source: how FHIR R4 traffic decodes into resources, and the
 * assembled source built from that decode.
 *
 * @remarks
 * Three layers, all exported from here:
 *
 * - the three entities (`PatientEntity`, `ObservationEntity`,
 *   `ObservationListEntity`) and the `fhirR4EntityDefinitions` tuple — the
 *   **single definition** of how FHIR R4 traffic decodes, consumed by this
 *   package's source surface and by the live scraping plan in
 *   `fhir-r4-client-collector` (which keys resources under its configured
 *   root);
 * - the recognition surface (`fhirR4Recognizer`, `fhirRootOf`) and the
 *   source entities (`fhirR4SourceEntities`, keying each resource under
 *   the root of the URL it arrived on);
 * - `fhirR4Source`, the whole source as one `Source.Source` value a
 *   consumer registers.
 *
 * The collector's own concerns — config schema, scraping plan, config form,
 * descriptor — stay in `fhir-r4-client-collector`, which depends on this
 * package. No DOM, no `fs`, no React.
 *
 * @packageDocumentation
 */
export { PatientEntity } from './entities/patient-entity.ts'
export { ObservationEntity } from './entities/observation-entity.ts'
export { ObservationListEntity } from './entities/observation-list-entity.ts'
export { extractJson } from './extract-json.ts'
export { fhirR4EntityDefinitions } from './plan-entities.ts'
export { fhirR4Recognizer, fhirRootOf } from './recognizer.ts'
export { fhirR4SourceEntities } from './source-entities.ts'
export { fhirR4Source } from './source.ts'
