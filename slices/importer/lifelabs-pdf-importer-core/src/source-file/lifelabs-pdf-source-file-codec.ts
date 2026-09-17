import { SourceFile } from 'importer-fundamentals'

import { LIFELABS_SYSTEM } from '../source-system.ts'

/**
 * How a whole LifeLabs report PDF is stored as a FHIR R4 `DocumentReference` —
 * the LifeLabs binding of `importer-fundamentals`' shared
 * {@link sourceFileCodec}.
 *
 * @remarks
 * Structurally the HAR source file with a different coding: PDF content type,
 * LifeLabs coding under `LIFELABS_SYSTEM|lifelabs-pdf-archive`, and no
 * web-trace security label. The shared codec builder lives in
 * `importer-fundamentals`; this file supplies that config as data and
 * re-exports only what the binding consumes. Nothing here parses the PDF; the
 * bytes are carried, hashed, and handed back exactly as they arrived, and every
 * FHIR resource this importer writes stamps this source file's reference onto
 * `meta.source`.
 *
 * @packageDocumentation
 */

/**
 * The coding code for the LifeLabs PDF source file category. Reuses
 * `LIFELABS_SYSTEM` (the source-system URI resources are keyed under) with a
 * distinct code so the `type`/`category` axis is discoverable from one place.
 */
const LIFELABS_PDF_SOURCE_FILE_CODE = 'lifelabs-pdf-archive'

/** The attachment's media type — the actual PDF content type. */
const LIFELABS_PDF_SOURCE_FILE_CONTENT_TYPE = 'application/pdf'

/**
 * The LifeLabs binding of the shared source-file codec — the whole codec
 * object, whose `buildSourceFile` the descriptor's `decode` mints this
 * format's source file with (through `perFileDecode`).
 */
const lifeLabsPdfSourceFileCodec = SourceFile.codec({
  format: 'lifelabs-pdf',
  coding: { system: LIFELABS_SYSTEM, code: LIFELABS_PDF_SOURCE_FILE_CODE },
  contentType: LIFELABS_PDF_SOURCE_FILE_CONTENT_TYPE,
  descriptionPrefix: 'LifeLabs report PDF: ',
  sourceFileName: 'LifeLabsPdfSourceFile',
  label: 'One uploaded LifeLabs report PDF',
  idDescription:
    'FHIR resource id of an uploaded LifeLabs PDF source file; deterministic in the file hash and name.',
})

/**
 * The `category` search token every server-side source file read filters on, in
 * FHIR's `system|code` form so a bare `lifelabs-pdf-archive` code in some other
 * system cannot match.
 */
const LIFELABS_PDF_SOURCE_FILE_CATEGORY_TOKEN = lifeLabsPdfSourceFileCodec.categoryToken

/** Reads a decoded `DocumentReference` back as the LifeLabs PDF source file it carries. */
const lifeLabsPdfSourceFileFromDocumentReference =
  lifeLabsPdfSourceFileCodec.sourceFileFromDocumentReference

/** Whether a decoded `DocumentReference` is an uploaded LifeLabs PDF source file, by `category`. */
const isLifeLabsPdfSourceFile = lifeLabsPdfSourceFileCodec.isSourceFile

/** Mints a picked PDF's source file `DocumentReference` — what `perFileDecode` mints with. */
const buildSourceFile = lifeLabsPdfSourceFileCodec.buildSourceFile

export {
  buildSourceFile,
  isLifeLabsPdfSourceFile,
  LIFELABS_PDF_SOURCE_FILE_CATEGORY_TOKEN,
  LIFELABS_PDF_SOURCE_FILE_CODE,
  LIFELABS_PDF_SOURCE_FILE_CONTENT_TYPE,
  lifeLabsPdfSourceFileCodec,
  lifeLabsPdfSourceFileFromDocumentReference,
}
