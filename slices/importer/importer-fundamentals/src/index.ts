/**
 * The resource-agnostic upstream of the importer slice: the
 * {@link FileImporterDescriptor} contract every file-format binding implements,
 * the per-resource {@link StagedImport} model (selection state — exclude/edit per
 * resource), and the structural {@link PersistFailure} the sinks report against.
 *
 * @remarks
 * Names no source-file *format* and no extracted resource type — a format
 * binding (`har-importer-core`) supplies those. It does, however, own the one
 * shared definition of how any uploaded source file is stored as a FHIR
 * `DocumentReference` ({@link SourceFile.codec}): the HAR and LifeLabs codecs
 * were identical bar their coding, so the shape lives here and each binding
 * passes its coding in as data — and the generic review-side pieces
 * ({@link SourceFile.perFileDecode}, {@link SourceFile.resolve},
 * {@link SourceFile.withSections}, {@link MetaSource.stamp}) every format's
 * `decode` composes to mint, list, and link its own source file. The
 * {@link PickedFile} every decode receives lives here too. No DOM, no `fs`,
 * no React: this package is pure data + transitions the shell and a format's
 * React package drive.
 *
 * @packageDocumentation
 */
export * as MetaSource from './meta-source.ts'
export * as PickedFileSource from './picked-file-source.ts'
export * as SourceFile from './source-file.ts'
export * as SourceFileFhirReference from './source-file-fhir-reference.ts'
export * as StagedImport from './staged-import.ts'
export { identify, sectionResources, unitId } from './file-importer-descriptor.ts'
export type {
  DecodedFile,
  DocumentReferenceType,
  FileImporterDescriptor,
  LabeledResource,
  LabeledSection,
  ReadUnit,
  SettingsPickerProps,
  UnreadableUnit,
} from './file-importer-descriptor.ts'
export type { PickedFile } from './picked-file.ts'
export type { PersistFailure } from './persist-failure.ts'
export { DigestUnavailable, sha256Base64 } from './sha256.ts'
