/**
 * The FHIR R4 importer project: the decode surface shared by the live
 * `fhir-r4-client-collector` plan and the archive importer.
 *
 * @remarks
 * Two layers, both exported from here:
 *
 * - the three entities (`PatientEntity`, `ObservationEntity`,
 *   `ObservationListEntity`) and the `fhirR4EntityDefinitions` tuple — the
 *   **single definition** of how FHIR R4 traffic decodes, consumed by the live
 *   scraping plan (which keys resources under its configured root) and by the
 *   offline surface below;
 * - the offline surface (`offlineEntities`, `fhirR4Recognizer`, `fhirRootOf`)
 *   an archive importer drives when there is no live sniffer, keying each
 *   resource under the root of the URL it arrived on.
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
export { fhirR4Recognizer, fhirRootOf, offlineEntities } from './offline.ts'
