import { sourceArchiveCodec } from 'importer-fundamentals'

import {
  HAR_ARCHIVE_CODE,
  WEB_TRACE_CODE_SYSTEM,
  WEB_TRACE_RAW_CODE,
  WEB_TRACE_REDACTION_SYSTEM,
} from 'web-trace-core/codec'

/**
 * How a whole `.har` file is stored as a FHIR R4 `DocumentReference` — the HAR
 * binding of `importer-fundamentals`' shared {@link sourceArchiveCodec}.
 *
 * @remarks
 * This is the *archive* encoding, not the trace encoding. A trace is one
 * recorded HTTP exchange this system captured itself; an archive is an opaque
 * `.har` file someone uploaded, kept whole so the importer can parse it later.
 * The two share a code system and nothing else, and {@link isHarArchive} /
 * `isWebTrace` are disjoint by construction — the viewer must never list an
 * archive and the importer must never list a trace. The shared codec builder
 * lives in `importer-fundamentals`; this file supplies HAR's coding, content
 * type, and the web-trace raw `securityLabel` as data, and re-exports only what
 * the binding consumes. The web-trace constants still originate in
 * `web-trace-core` (a trace and an archive sit on the same axis under different
 * codes); passing them in keeps the builder itself free of any `web-trace-core`
 * dependency.
 *
 * Nothing here parses the archive. The bytes are carried, hashed, and handed
 * back exactly as they arrived; reading them is `src/decode-har.ts`'s job.
 *
 * @packageDocumentation
 */

/**
 * The attachment's media type.
 *
 * @remarks
 * HAR has no registered MIME type — the format is JSON, and `.har` files are
 * served as `application/json` in practice. The coding, not the content type, is
 * what says "this is a HAR archive"; a reader must not discriminate on this
 * value.
 */
const HAR_ARCHIVE_CONTENT_TYPE = 'application/json'

const codec = sourceArchiveCodec({
  coding: { system: WEB_TRACE_CODE_SYSTEM, code: HAR_ARCHIVE_CODE },
  contentType: HAR_ARCHIVE_CONTENT_TYPE,
  descriptionPrefix: 'HAR archive: ',
  // An uploaded archive is unredacted by construction — it is whatever the
  // recorder captured. Same marker a trace carries, so "raw" means one thing
  // across the slice.
  securityLabel: [{ system: WEB_TRACE_REDACTION_SYSTEM, code: WEB_TRACE_RAW_CODE }],
  archiveName: 'HarArchive',
  label: 'One uploaded HAR file',
  idDescription:
    'FHIR resource id of an uploaded HAR archive; deterministic in the file hash and name.',
})

/**
 * The `category` search token every server-side archive read filters on, in
 * FHIR's `system|code` form so a bare `har-archive` code in some other system
 * cannot match.
 */
const HAR_ARCHIVE_CATEGORY_TOKEN = codec.categoryToken

/** Reads a decoded `DocumentReference` back as the HAR archive it carries. */
const harArchiveFromDocumentReference = codec.archiveFromDocumentReference

/** Whether a decoded `DocumentReference` is an uploaded HAR archive, by `category`. */
const isHarArchive = codec.isArchive

/** Mints a picked `.har` file's archive `DocumentReference` — the descriptor's `sourceArchive`. */
const sourceArchive = codec.sourceArchive

export {
  HAR_ARCHIVE_CATEGORY_TOKEN,
  HAR_ARCHIVE_CONTENT_TYPE,
  harArchiveFromDocumentReference,
  isHarArchive,
  sourceArchive,
}
