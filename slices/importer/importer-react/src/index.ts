/**
 * The browser UI adapter of the importer slice: the source picker that hands the
 * importer one HAR to replay.
 *
 * @remarks
 * Three inputs converge on one {@link PickedHar} — a file dropped on the zone, a
 * file chosen through the OS picker, and a HAR archive already uploaded to the
 * device's own FHIR server. Presentation and interaction only: the HAR parser
 * and the archive codec both live in `web-trace-core`, below this package, and a
 * local pick is validated *through* that parser rather than a second check here.
 *
 * This ticket runs parallel with `importer-core`, so nothing here imports it —
 * the picker's job ends at a {@link PickedHar}, which is the seam the rest of the
 * importer consumes.
 *
 * @packageDocumentation
 */
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
