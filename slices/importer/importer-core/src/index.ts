/**
 * The pure core of the importer slice: turn an uploaded HAR archive into a
 * previewed set of FHIR resources, then — as a separate, opt-in step — write
 * them.
 *
 * @remarks
 * `HarImport.run` is the read half (detect which registered importer claims
 * the archive, run its entities, fold the extraction into an
 * `ImportPreview.ImportPreview`); `ImportPreview.persist` is the write half.
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
export { importers } from './importers.ts'
