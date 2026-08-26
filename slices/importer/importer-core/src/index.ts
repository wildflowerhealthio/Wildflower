/**
 * The pure core of the importer slice: turn an uploaded HAR archive into a
 * previewed set of FHIR resources, then — as a separate, opt-in step — write
 * them.
 *
 * @remarks
 * `runHarImport` is the read half (detect which registered collector understands
 * the archive, replay its offline entities, fold the result into an
 * {@link ImportPreview}); `persistPreview` is the write half. The two are split
 * so a caller previews, shows the user what would be written, and only then
 * confirms — the read half cannot write, by construction.
 *
 * No DOM, no `fs`, no React: this package reads archive text and returns data
 * (and, for the write half, requires the FHIR write client). Adapters drive it.
 *
 * @packageDocumentation
 */
export type {
  ImportParseFailure,
  ImportPreview,
  NoCollectorClaims,
  Preview,
} from './import-preview.ts'
export { persistPreview } from './persist-preview.ts'
export {
  type ArchiveContext,
  fhirR4Registered,
  REGISTERED_COLLECTORS,
  type RegisteredCollector,
} from './registered-collectors.ts'
export { runHarImport, toReplayResponse } from './run-har-import.ts'
