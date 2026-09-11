/**
 * The browser UI adapter of the importer slice: the whole preview-then-confirm
 * flow, from picking a file to reading the results.
 *
 * @remarks
 * The package's public surface is deliberately small. A host app mounts
 * {@link ImporterScreen} — that alone runs the flow, owning every level below
 * it: the three pick sources (a file dropped on the zone, a file chosen through
 * the OS picker, and a HAR archive already uploaded to the device's own FHIR
 * server via {@link ServerHarArchiveList}); the read half that folds each pick's
 * format-specific decode into a shared sectioned preview writing nothing; and
 * the explicit confirm that uploads the source archive when needed and persists
 * the reviewed resources, each stamped with the archive it came from.
 *
 * Only three other symbols are exported, and each for a stated reason:
 * {@link ServerHarArchiveList}, because the anonymizer slice's shell mounts it
 * in its own `serverSource` slot; and {@link PREVIEW_HEADING} /
 * {@link COMPLETE_HEADING}, the stable heading strings a host drives its own
 * end-to-end assertions against. Everything else — the registry, the review
 * model view, the queries, the individual pick sources — is an internal
 * building block reached through {@link ImporterScreen}, not imported directly.
 *
 * @packageDocumentation
 */
export { ImporterScreen } from './importer-screen.tsx'
export { PREVIEW_HEADING } from './preview/preview-panel.tsx'
export { COMPLETE_HEADING } from './results/import-results.tsx'
export { ServerHarArchiveList } from './sources/server-har-archive-list.tsx'
