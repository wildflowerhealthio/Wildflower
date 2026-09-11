/**
 * The browser UI adapter of the importer slice: the whole preview-then-confirm
 * flow, from picking a file to reading the results.
 *
 * @remarks
 * {@link ImporterScreen} is the surface a host app mounts — the slice owns
 * every level. Three inputs converge on one {@link PickedFile} — a file
 * dropped on the zone, a file chosen through the OS picker, and a HAR
 * archive already uploaded to the device's own FHIR server; the read half
 * (each file's format-specific `decode`, via {@link useImportRun}) folds
 * every pick into a {@link PreviewPanel} preview writing nothing; and only
 * the explicit confirm ({@link useConfirmImport}) uploads the archive when
 * needed and persists the resources, each stamped with the archive it came
 * from. Presentation and interaction only: the parsers, the review model,
 * and the persist pipeline all live below this package.
 *
 * @packageDocumentation
 */
export { ImporterScreen, READING_MESSAGE } from './importer-screen.tsx'
export {
  NOTHING_TO_IMPORT_HEADING,
  PREVIEW_HEADING,
  PreviewPanel,
  type PreviewPanelProps,
  type ReviewBodyRegistry,
  UNREADABLE_FILE_MESSAGE,
  UNRECOGNIZED_FILE_MESSAGE,
} from './preview/preview-panel.tsx'
export {
  type ConfirmImport,
  type ConfirmState,
  type LabeledFor,
  type PersistRegistry,
  type SelectionFor,
  useConfirmImport,
} from './preview/use-confirm-import.ts'
export {
  type BoundFormat,
  type FormatKind,
  type FormatVariant,
  type ReviewBodyAdapterProps,
  formatRegistry,
} from './registry.tsx'
export {
  type FileReadOutcome,
  type ImportRun,
  type ImportRunRegistry,
  type ImportRunState,
  useImportRun,
} from './preview/use-import-run.ts'
export {
  type BatchOutcome,
  type BatchSummary,
  type FileImportResult,
  type ImportOutcome,
  importOutcome,
  isPartialBatch,
  isPartialOutcome,
  type SkipReason,
  summarizeBatch,
} from './results/import-outcome.ts'
export {
  COMPLETE_HEADING,
  ImportResults,
  type ImportResultsProps,
  PARTIAL_HEADING,
} from './results/import-results.tsx'
export {
  fetchHarArchive,
  HAR_ARCHIVE_CATEGORY_TOKEN,
  type HarArchivePage,
  type HarArchiveRow,
  harArchivesInfiniteQueryOptions,
  type HarArchivesQueryKey,
  type HarArchivesQueryOptions,
  DEFAULT_PAGE_SIZE as HAR_ARCHIVES_DEFAULT_PAGE_SIZE,
  useHarArchivesQuery,
} from './queries/har-archives.ts'
export { HAR_ARCHIVES_QUERY_KEY, IMPORTER_QUERY_KEY } from './queries/keys.ts'
export { nextPageToken, type PageLink } from './queries/page-token.ts'
export { type UploadHarInput, useUploadHar } from './mutations/upload-har.ts'
export { acceptLocalFile, type ReadableFile, REJECTION_MESSAGE } from './sources/local-file.ts'
export {
  harArchiveReference,
  LOCAL_SOURCE,
  type PickedFile,
  type PickedFileSource,
  serverSource,
} from './sources/picked-file.ts'
export {
  SERVER_READ_ERROR,
  ServerHarArchiveList,
  type ServerHarArchiveListProps,
  UNDATED_LABEL,
  UNTITLED_LABEL,
} from './sources/server-har-archive-list.tsx'
export {
  SourcePicker,
  type SourcePickerMode,
  type SourcePickerProps,
} from './sources/source-picker.tsx'
