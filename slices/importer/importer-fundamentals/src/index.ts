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
 * `DocumentReference` ({@link sourceFileCodec}): the HAR and LifeLabs codecs
 * were identical bar their coding, so the shape lives here and each binding
 * passes its coding in as data. No DOM, no `fs`, no React: this package is pure
 * data + transitions the shell and a format's React package drive.
 *
 * @packageDocumentation
 */
export * as StagedImport from './staged-import.ts'
export { identify, sectionResources } from './file-importer-descriptor.ts'
export type {
  DecodedFile,
  DocumentReferenceType,
  FileImporterDescriptor,
  LabeledResource,
  LabeledSection,
  SettingsPickerProps,
} from './file-importer-descriptor.ts'
export type { PersistFailure } from './persist-failure.ts'
export { DigestUnavailable, sha256Base64 } from './sha256.ts'
export {
  type SourceFile,
  type SourceFileCodec,
  type SourceFileConfig,
  sourceFileCodec,
} from './source-file-codec.ts'
