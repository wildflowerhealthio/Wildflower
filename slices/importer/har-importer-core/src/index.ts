/**
 * The HAR binding of the importer slice: the concrete `FileImporter`
 * for format `'har'`, assembled from the `http-archive` HAR projection, the
 * FHIR R4 response-kind pool, and the HAR source-file coding.
 *
 * @remarks
 * This is where the resource-agnostic `importer-fundamentals` contract is bound
 * to a concrete format (HAR) and resource type (FHIR). No DOM, no `fs`, no
 * React: HAR bytes in, FHIR resources out — the extracted resources plus the
 * source-file `DocumentReference` {@link harImporter}'s `decode` mints for a
 * local pick. The write is the shell's, gated on a confirmed
 * review.
 *
 * @packageDocumentation
 */
// The HAR source-file coding constants are web-trace's, and reach consumers
// through the `./source-file` subpath (the seam every binding has) — not from
// here, and not through `har-importer.ts`, which only reads them.
export { harImporter } from './har-importer.ts'
export { decodeHar, toInput } from './decode-har.ts'
export { detectHar, looksLikeJson } from './detect-har.ts'
export { fhirSources } from './fhir-pool.ts'
export { defaultHarSettings, type HarSettings } from './har-settings.ts'
