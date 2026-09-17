/**
 * The HAR binding of the importer slice: the concrete `FileImporterDescriptor`
 * for format `'har'`, assembled from the `http-archive` HAR projection, the
 * FHIR R4 response-kind pool, and the HAR source-file codec.
 *
 * @remarks
 * This is where the resource-agnostic `importer-fundamentals` contract is bound
 * to a concrete format (HAR) and resource type (FHIR). No DOM, no `fs`, no
 * React: HAR bytes in, FHIR resources out — the extracted resources plus the
 * source-file `DocumentReference` {@link harImporterDescriptor}'s `decode`
 * mints for a local pick. The write is the shell's, gated on a confirmed
 * review.
 *
 * @packageDocumentation
 */
export { harImporter } from './har-importer.ts'
export { decodeHar, toInput } from './decode-har.ts'
export { detectHar, looksLikeJson } from './detect-har.ts'
export { buildSourceFile } from './source-file/index.ts'
export { fhirSources } from './fhir-pool.ts'
export { defaultHarSettings, type HarSettings } from './har-settings.ts'
