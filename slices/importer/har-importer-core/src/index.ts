/**
 * The HAR binding of the importer slice: the concrete `FileImporterDescriptor`
 * for format `'har'`, assembled from `web-trace-core`'s HAR codec, the FHIR R4
 * response-kind pool, and the FHIR persist sink.
 *
 * @remarks
 * This is where the resource-agnostic `importer-fundamentals` contract is bound
 * to a concrete format (HAR) and resource type (FHIR). No DOM, no `fs`, no
 * React: HAR text in, FHIR resources out, an opt-in write behind
 * {@link harImporterDescriptor}'s `persist`.
 *
 * @packageDocumentation
 */
export { harImporterDescriptor } from './har-importer.ts'
export { decodeHar, toInput } from './decode-har.ts'
export { persistFhir } from './persist-fhir.ts'
export { fhirPool, fhirSources } from './fhir-pool.ts'
export { defaultHarSettings, type HarSettings } from './har-settings.ts'
