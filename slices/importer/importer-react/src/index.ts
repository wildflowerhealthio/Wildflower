/**
 * The browser UI adapter of the importer slice: the whole preview-then-confirm
 * flow, from picking a HAR to reading the results.
 *
 * @remarks
 * {@link ImporterScreen} is the surface a host app mounts — the slice owns every
 * level. Three inputs converge on one {@link PickedHar} — a file dropped on the
 * zone, a file chosen through the OS picker, and a HAR archive already uploaded to
 * the device's own FHIR server; the read half (`importer-core`'s `HarImport.run`,
 * via {@link useImportRun}) folds it into an {@link PreviewPanel} preview writing
 * nothing; and only the explicit confirm ({@link useConfirmImport}) uploads the
 * archive when needed and persists the resources, each stamped with the archive
 * it came from. Presentation and interaction only: the HAR parser, the archive
 * codec, and the detect/extract/persist pipeline all live below this package.
 *
 * @packageDocumentation
 */
export { ImporterScreen, READING_MESSAGE } from './importer-screen.tsx'
export {
  NOTHING_TO_IMPORT_HEADING,
  PREVIEW_HEADING,
  PreviewPanel,
  type PreviewPanelProps,
  UNREADABLE_FILE_MESSAGE,
} from './preview/preview-panel.tsx'
export {
  type ConfirmImport,
  type ConfirmState,
  type SelectionFor,
  useConfirmImport,
} from './preview/use-confirm-import.ts'
export {
  type Format,
  type FormatRegistration,
  formatRegistry,
  harRegistration,
} from './registry.ts'
export {
  type ImportRun,
  type ImportRunState,
  type FileReadOutcome,
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
export { acceptLocalHar, type ReadableFile, REJECTION_MESSAGE } from './sources/local-har.ts'
export {
  harArchiveReference,
  LOCAL_SOURCE,
  type PickedHar,
  type PickedHarSource,
  serverSource,
} from './sources/picked-har.ts'
export {
  SERVER_READ_ERROR,
  SourcePicker,
  type SourcePickerProps,
  UNDATED_LABEL,
  UNTITLED_LABEL,
} from './sources/source-picker.tsx'
