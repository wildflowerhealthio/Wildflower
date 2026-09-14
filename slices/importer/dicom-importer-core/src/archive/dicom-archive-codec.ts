import { sourceArchiveCodec } from 'importer-fundamentals'

import { DICOM_SYSTEM } from '../source-system.ts'

/**
 * How a whole DICOM file is stored as a FHIR R4 `DocumentReference` — the
 * DICOM binding of `importer-fundamentals`' shared {@link sourceArchiveCodec}.
 *
 * @remarks
 * Structurally the LifeLabs PDF archive with a different coding: DICOM content
 * type, DICOM coding under `DICOM_SYSTEM|dicom-archive`, and no security
 * label. The shared codec builder lives in `importer-fundamentals`; this file
 * supplies that config as data and re-exports only what the binding consumes.
 * Nothing here reads any DICOM tag; the bytes are carried, hashed, and handed
 * back exactly as they arrived, and every FHIR resource a future D3 decode
 * writes will stamp this archive's reference onto `meta.source`.
 *
 * @packageDocumentation
 */

const DICOM_ARCHIVE_CODE = 'dicom-archive'

const DICOM_ARCHIVE_CONTENT_TYPE = 'application/dicom'

const codec = sourceArchiveCodec({
  coding: { system: DICOM_SYSTEM, code: DICOM_ARCHIVE_CODE },
  contentType: DICOM_ARCHIVE_CONTENT_TYPE,
  descriptionPrefix: 'DICOM file: ',
  archiveName: 'DicomArchive',
  label: 'One uploaded DICOM file',
  idDescription:
    'FHIR resource id of an uploaded DICOM archive; deterministic in the file hash and name.',
})

const DICOM_ARCHIVE_CATEGORY_TOKEN = codec.categoryToken

const dicomArchiveFromDocumentReference = codec.archiveFromDocumentReference

const isDicomArchive = codec.isArchive

const sourceArchive = codec.sourceArchive

export {
  DICOM_ARCHIVE_CATEGORY_TOKEN,
  DICOM_ARCHIVE_CODE,
  DICOM_ARCHIVE_CONTENT_TYPE,
  dicomArchiveFromDocumentReference,
  isDicomArchive,
  sourceArchive,
}
