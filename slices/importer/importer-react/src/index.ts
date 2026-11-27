/**
 * The browser UI adapter of the importer slice: the whole import flow, from
 * choosing files to writing their import plan.
 *
 * @remarks
 * The package's public surface is deliberately small. A host app mounts
 * {@link ImporterScreen} — that alone runs the flow, owning every level below
 * it: the three pick sources (a file dropped on the zone, a file chosen through
 * the OS picker, and an uploaded source file already on the FHIR server via
 * {@link ServerSourceFileList}, spanning every registered format); the read
 * that turns the picked files into an import plan against the existing
 * records, writing nothing; and the explicit Import that writes the plan as
 * one transaction, each record stamped with the source file it came from.
 *
 * Only four other symbols are exported, and each for a stated reason:
 * {@link ServerSourceFileList}, because the anonymizer's shell mounts
 * it in its own `serverSource` slot; {@link IMPORT_PLAN_KICKER} /
 * {@link COMPLETE_HEADING}, the stable strings a host drives its own
 * end-to-end assertions against; and {@link ImporterWalkthroughAnchor}, the
 * `data-walkthrough` values on the first screen's controls, which a host's
 * first-run walkthrough points at. Everything else — the registry, the import
 * plan page, the queries, the individual pick sources — is an internal
 * building block reached through {@link ImporterScreen}, not imported directly.
 *
 * @packageDocumentation
 */
export { ImporterScreen } from './importer-screen.tsx'
export { COMPLETE_HEADING, IMPORT_PLAN_KICKER } from './plan/plan-text.ts'
export { ServerSourceFileList } from './sources/server-source-file-list.tsx'
export { ImporterWalkthroughAnchor } from './walkthrough-anchors.ts'
