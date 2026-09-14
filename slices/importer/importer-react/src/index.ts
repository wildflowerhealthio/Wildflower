/**
 * The browser UI adapter of the importer slice: the whole preview-then-confirm
 * flow, from picking a file to reading the results.
 *
 * @remarks
 * The package's public surface is deliberately small. A host app mounts
 * {@link ImporterScreen} — that alone runs the flow, owning every level below
 * it: the three pick sources (a file dropped on the zone, a file chosen through
 * the OS picker, and an uploaded source file already on the device's own FHIR
 * server via {@link ServerSourceFileList}, spanning every registered format);
 * the read half that folds each pick's format-specific decode into a shared
 * sectioned preview writing nothing; and the explicit confirm that uploads
 * the source file when needed and persists the reviewed resources, each
 * stamped with the source file it came from.
 *
 * Only three other symbols are exported, and each for a stated reason:
 * {@link ServerSourceFileList}, because the anonymizer slice's shell mounts
 * it in its own `serverSource` slot; and {@link PREVIEW_HEADING} /
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
export { ServerSourceFileList } from './sources/server-source-file-list.tsx'
