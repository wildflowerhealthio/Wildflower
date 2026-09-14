import { sourceFileCodec } from 'importer-fundamentals'

import {
  HAR_ARCHIVE_CODE,
  WEB_TRACE_CODE_SYSTEM,
  WEB_TRACE_RAW_CODE,
  WEB_TRACE_REDACTION_SYSTEM,
} from 'web-trace-core/codec'

/**
 * How a whole `.har` file is stored as a FHIR R4 `DocumentReference` — the HAR
 * binding of `importer-fundamentals`' shared {@link sourceFileCodec}.
 *
 * @remarks
 * This is the *source file* encoding, not the trace encoding. A trace is one
 * recorded HTTP exchange this system captured itself; a source file is an opaque
 * `.har` file someone uploaded, kept whole so the importer can parse it later.
 * The two share a code system and nothing else, and {@link isHarSourceFile} /
 * `isWebTrace` are disjoint by construction — the viewer must never list a
 * source file and the importer must never list a trace. The shared codec builder
 * lives in `importer-fundamentals`; this file supplies HAR's coding, content
 * type, and the web-trace raw `securityLabel` as data, and re-exports only what
 * the binding consumes. The web-trace constants still originate in
 * `web-trace-core` (a trace and a source file sit on the same axis under different
 * codes); passing them in keeps the builder itself free of any `web-trace-core`
 * dependency.
 *
 * Nothing here parses the source file. The bytes are carried, hashed, and handed
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
 * what says "this is a HAR source file"; a reader must not discriminate on this
 * value.
 */
const HAR_SOURCE_FILE_CONTENT_TYPE = 'application/json'

const codec = sourceFileCodec({
  coding: { system: WEB_TRACE_CODE_SYSTEM, code: HAR_ARCHIVE_CODE },
  contentType: HAR_SOURCE_FILE_CONTENT_TYPE,
  descriptionPrefix: 'HAR archive: ',
  // An uploaded source file is unredacted by construction — it is whatever the
  // recorder captured. Same marker a trace carries, so "raw" means one thing
  // across the slice.
  securityLabel: [{ system: WEB_TRACE_REDACTION_SYSTEM, code: WEB_TRACE_RAW_CODE }],
  sourceFileName: 'HarSourceFile',
  label: 'One uploaded HAR file',
  idDescription:
    'FHIR resource id of an uploaded HAR source file; deterministic in the file hash and name.',
})

/**
 * The `category` search token every server-side source file read filters on, in
 * FHIR's `system|code` form so a bare `har-archive` code in some other system
 * cannot match.
 */
const HAR_SOURCE_FILE_CATEGORY_TOKEN = codec.categoryToken

/** Reads a decoded `DocumentReference` back as the HAR source file it carries. */
const harSourceFileFromDocumentReference = codec.sourceFileFromDocumentReference

/** Whether a decoded `DocumentReference` is an uploaded HAR source file, by `category`. */
const isHarSourceFile = codec.isSourceFile

/** Mints a picked `.har` file's source file `DocumentReference` — the descriptor's `buildSourceFile`. */
const buildSourceFile = codec.buildSourceFile

export {
  HAR_SOURCE_FILE_CATEGORY_TOKEN,
  HAR_SOURCE_FILE_CONTENT_TYPE,
  harSourceFileFromDocumentReference,
  isHarSourceFile,
  buildSourceFile,
}
