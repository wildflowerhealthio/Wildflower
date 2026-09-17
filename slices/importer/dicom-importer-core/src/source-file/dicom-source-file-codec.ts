import { SourceFile } from 'importer-fundamentals'

import { DICOM_SYSTEM } from '../source-system.ts'

/**
 * How a whole DICOM file is stored as a FHIR R4 `DocumentReference` — the
 * DICOM binding of `importer-fundamentals`' shared {@link sourceFileCodec}.
 *
 * @remarks
 * Structurally the LifeLabs PDF source file with a different coding: DICOM
 * content type, DICOM coding under `DICOM_SYSTEM|dicom-source-file`, and no
 * security label. The shared codec builder lives in `importer-fundamentals`;
 * this file supplies that config as data and re-exports only what the binding
 * consumes. Nothing here reads any DICOM tag; the bytes are carried, hashed,
 * and handed back exactly as they arrived, and every FHIR resource a future D3
 * decode writes will stamp this source file's reference onto `meta.source`.
 *
 * @packageDocumentation
 */

const DICOM_SOURCE_FILE_CODE = 'dicom-source-file'

const DICOM_SOURCE_FILE_CONTENT_TYPE = 'application/dicom'

const dicomSourceFileCodec = SourceFile.codec({
  coding: { system: DICOM_SYSTEM, code: DICOM_SOURCE_FILE_CODE },
  contentType: DICOM_SOURCE_FILE_CONTENT_TYPE,
  descriptionPrefix: 'DICOM file: ',
  sourceFileName: 'DicomSourceFile',
  label: 'One uploaded DICOM file',
  idDescription:
    'FHIR resource id of an uploaded DICOM source file; deterministic in the file hash and name.',
})

const DICOM_SOURCE_FILE_CATEGORY_TOKEN = dicomSourceFileCodec.categoryToken

const dicomSourceFileFromDocumentReference = dicomSourceFileCodec.sourceFileFromDocumentReference

const isDicomSourceFile = dicomSourceFileCodec.isSourceFile

const buildSourceFile = dicomSourceFileCodec.buildSourceFile

export {
  buildSourceFile,
  DICOM_SOURCE_FILE_CATEGORY_TOKEN,
  DICOM_SOURCE_FILE_CODE,
  DICOM_SOURCE_FILE_CONTENT_TYPE,
  dicomSourceFileCodec,
  dicomSourceFileFromDocumentReference,
  isDicomSourceFile,
}
