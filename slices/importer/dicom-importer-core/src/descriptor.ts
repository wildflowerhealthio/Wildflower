import { Effect } from 'effect'
import type { FhirResource } from 'fhir-r4/resources'
import type { FileImporterDescriptor } from 'importer-fundamentals'

import {
  DICOM_ARCHIVE_CATEGORY_TOKEN,
  DICOM_ARCHIVE_CONTENT_TYPE,
  dicomArchiveFromDocumentReference,
  isDicomArchive,
  sourceArchive,
} from './archive/index.ts'
import { decodeDicom } from './decode.ts'
import { detectDicom } from './detect.ts'
import { defaultDicomSettings, type DicomSettings } from './settings.ts'

/**
 * The concrete {@link FileImporterDescriptor} for the `dicom` format: a `.dcm`
 * file's raw bytes in, zero extracted resources out (D3 fills the sections
 * in). Persistence is shell-owned — every FHIR-targeting importer writes
 * through one shared `POST /` batch bundle (`persistBatchBundle` in
 * `fhir-r4/clients`), so no format brings its own `persist`.
 *
 * @remarks
 * `decode` yields zero sections and one note — this format reads no DICOM tags
 * yet — so a confirm writes only the source-file archive `DocumentReference`
 * and nothing else.
 */
const dicomImporterDescriptor: FileImporterDescriptor<DicomSettings, FhirResource> = {
  format: 'dicom',
  display: {
    title: 'DICOM image',
    description: 'Import a DICOM (.dcm) file as an archive.',
  },
  accept: ['.dcm', 'application/dicom'],
  detect: detectDicom,
  defaultSettings: defaultDicomSettings,
  decode: decodeDicom,
  sourceArchive,
  archiveCategoryToken: DICOM_ARCHIVE_CATEGORY_TOKEN,
  isArchive: isDicomArchive,
  archiveFromDocumentReference: (resource) =>
    dicomArchiveFromDocumentReference(resource).pipe(
      Effect.map((archive) => ({ fileName: archive.fileName, bytes: archive.bytes }))
    ),
  archiveContentType: DICOM_ARCHIVE_CONTENT_TYPE,
}

export { dicomImporterDescriptor }
