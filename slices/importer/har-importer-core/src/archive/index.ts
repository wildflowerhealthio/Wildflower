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
  HAR_ARCHIVE_CONTENT_TYPE,
  HarArchive,
  HarArchiveFromDocumentReference,
  HarArchiveFromFhirJson,
  harArchiveFromDocumentReference,
  HarArchiveId,
  harArchiveToDocumentReference,
  harArchiveToWire,
  isHarArchive,
} from './har-archive-codec.ts'
import { HAR_ARCHIVE_CODE, WEB_TRACE_CODE_SYSTEM } from 'web-trace-core/codec'

/**
 * The `category` search token every server-side archive read filters on, in
 * FHIR's `system|code` form so a bare `har-archive` code in some other system
 * cannot match.
 *
 * @remarks
 * Built from the codec's own constants; a second literal would drift the moment
 * either moved. Lives here (rather than in `importer-react`) so any consumer
 * that reads archives, in any adapter, spells the token the same way.
 */
const HAR_ARCHIVE_CATEGORY_TOKEN = `${WEB_TRACE_CODE_SYSTEM}|${HAR_ARCHIVE_CODE}` as const

// Re-exported here so a downstream reader needs only `har-importer-core/archive`
// to build the search token or write the coding. `WEB_TRACE_CODE_SYSTEM` is
// shared with a web-trace `DocumentReference` and still originates in
// `web-trace-core`; a trace and an archive sit on the same axis under different
// codes (`isWebTrace` / `isHarArchive` never both hold).
export { HAR_ARCHIVE_CATEGORY_TOKEN, HAR_ARCHIVE_CODE, WEB_TRACE_CODE_SYSTEM }
