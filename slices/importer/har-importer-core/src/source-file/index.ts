/**
 * The FHIR encoding of an uploaded `.har` file as a `DocumentReference`.
 *
 * @remarks
 * The source file codec: a whole `.har` file lives as one attachment, keyed under
 * the `har-archive` category. Disjoint from a trace, by category; the
 * `isHarSourceFile` / `isWebTrace` predicates never both hold on the same resource.
 *
 * @packageDocumentation
 */
export {
  HAR_SOURCE_FILE_CATEGORY_TOKEN,
  HAR_SOURCE_FILE_CONTENT_TYPE,
  harSourceFileFromDocumentReference,
  isHarSourceFile,
  buildSourceFile,
} from './har-source-file-codec.ts'

// Re-exported here so a downstream reader needs only `har-importer-core/source-file`
// to build the search token or write the coding. Both originate in
// `web-trace-core`; a trace and a source file sit on the same axis under different
// codes (`isWebTrace` / `isHarSourceFile` never both hold), and the codec's
// `HAR_SOURCE_FILE_CATEGORY_TOKEN` above is built from exactly these two.
export { HAR_ARCHIVE_CODE, WEB_TRACE_CODE_SYSTEM } from 'web-trace-core/codec'
