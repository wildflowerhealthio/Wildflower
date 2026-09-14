/**
 * The FHIR encoding of an uploaded `.har` file as a `DocumentReference`.
 *
 * @remarks
 * The archive codec: a whole `.har` file lives as one attachment, keyed under
 * the `har-archive` category. Disjoint from a trace, by category; the
 * `isHarArchive` / `isWebTrace` predicates never both hold on the same resource.
 *
 * @packageDocumentation
 */
export {
  HAR_ARCHIVE_CATEGORY_TOKEN,
  HAR_ARCHIVE_CONTENT_TYPE,
  harArchiveFromDocumentReference,
  isHarArchive,
  sourceArchive,
} from './har-archive-codec.ts'

// Re-exported here so a downstream reader needs only `har-importer-core/archive`
// to build the search token or write the coding. Both originate in
// `web-trace-core`; a trace and an archive sit on the same axis under different
// codes (`isWebTrace` / `isHarArchive` never both hold), and the codec's
// `HAR_ARCHIVE_CATEGORY_TOKEN` above is built from exactly these two.
export { HAR_ARCHIVE_CODE, WEB_TRACE_CODE_SYSTEM } from 'web-trace-core/codec'
