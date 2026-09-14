import { sourceArchiveCodec } from 'importer-fundamentals'

import { LIFELABS_SYSTEM } from '../source-system.ts'

/**
 * How a whole LifeLabs report PDF is stored as a FHIR R4 `DocumentReference` —
 * the LifeLabs binding of `importer-fundamentals`' shared
 * {@link sourceArchiveCodec}.
 *
 * @remarks
 * Structurally the HAR archive with a different coding: PDF content type,
 * LifeLabs coding under `LIFELABS_SYSTEM|lifelabs-pdf-archive`, and no
 * web-trace security label. The shared codec builder lives in
 * `importer-fundamentals`; this file supplies that config as data and
 * re-exports only what the binding consumes. Nothing here parses the PDF; the
 * bytes are carried, hashed, and handed back exactly as they arrived, and every
 * FHIR resource this importer writes stamps this archive's reference onto
 * `meta.source`.
 *
 * @packageDocumentation
 */

/**
 * The coding code for the LifeLabs PDF archive category. Reuses
 * `LIFELABS_SYSTEM` (the source-system URI resources are keyed under) with a
 * distinct code so the `type`/`category` axis is discoverable from one place.
 */
const LIFELABS_PDF_ARCHIVE_CODE = 'lifelabs-pdf-archive'

/** The attachment's media type — the actual PDF content type. */
const LIFELABS_PDF_ARCHIVE_CONTENT_TYPE = 'application/pdf'

const codec = sourceArchiveCodec({
  coding: { system: LIFELABS_SYSTEM, code: LIFELABS_PDF_ARCHIVE_CODE },
  contentType: LIFELABS_PDF_ARCHIVE_CONTENT_TYPE,
  descriptionPrefix: 'LifeLabs report PDF: ',
  archiveName: 'LifeLabsPdfArchive',
  label: 'One uploaded LifeLabs report PDF',
  idDescription:
    'FHIR resource id of an uploaded LifeLabs PDF archive; deterministic in the file hash and name.',
})

/**
 * The `category` search token every server-side archive read filters on, in
 * FHIR's `system|code` form so a bare `lifelabs-pdf-archive` code in some other
 * system cannot match.
 */
const LIFELABS_PDF_ARCHIVE_CATEGORY_TOKEN = codec.categoryToken

/** Reads a decoded `DocumentReference` back as the LifeLabs PDF archive it carries. */
const lifeLabsPdfArchiveFromDocumentReference = codec.archiveFromDocumentReference

/** Whether a decoded `DocumentReference` is an uploaded LifeLabs PDF archive, by `category`. */
const isLifeLabsPdfArchive = codec.isArchive

/** Mints a picked PDF's archive `DocumentReference` — the descriptor's `sourceArchive`. */
const sourceArchive = codec.sourceArchive

export {
  isLifeLabsPdfArchive,
  LIFELABS_PDF_ARCHIVE_CATEGORY_TOKEN,
  LIFELABS_PDF_ARCHIVE_CODE,
  LIFELABS_PDF_ARCHIVE_CONTENT_TYPE,
  lifeLabsPdfArchiveFromDocumentReference,
  sourceArchive,
}
