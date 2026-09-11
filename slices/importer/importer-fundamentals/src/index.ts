/**
 * The resource-agnostic upstream of the importer slice: the
 * {@link FileImporterDescriptor} contract every file-format binding implements,
 * the per-resource {@link Review} model (selection state — exclude/edit per
 * resource), and the structural {@link PersistFailure} the sinks report against.
 *
 * @remarks
 * Names no archive format and no resource type — a format binding
 * (`har-importer-core`) supplies those. No DOM, no `fs`, no React: this package
 * is pure data + transitions the shell and a format's React package drive.
 *
 * @packageDocumentation
 */
export * as Review from './review.ts'
export { acceptFor } from './file-importer-descriptor.ts'
export type { FileImporterDescriptor, LabeledResource } from './file-importer-descriptor.ts'
export type { PersistFailure } from './persist-failure.ts'
