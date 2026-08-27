/**
 * The pure core of the importer slice: turn an uploaded HAR archive into a
 * previewed set of FHIR resources, then — as a separate, opt-in step — write
 * them.
 *
 * @remarks
 * `HarImport.run` is the read half (run the flat `pool` of response kinds over
 * the archive's traffic per-URL, fold the extraction into an
 * `ImportPreview.Preview`); `ImportPreview.persist` is the write half.
 * The two are split so a caller previews, shows the user what would be
 * written, and only then confirms — the read half cannot write, by
 * construction.
 *
 * No DOM, no `fs`, no React: this package reads archive text and returns data
 * (and, for the write half, requires the FHIR write client). Adapters drive it.
 *
 * @packageDocumentation
 */
export * as HarImport from './har-import.ts'
export * as ImportPreview from './import-preview.ts'
export { pool } from './sources.ts'
