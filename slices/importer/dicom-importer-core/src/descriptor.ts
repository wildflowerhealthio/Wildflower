import { Effect } from 'effect'
import type { FhirResource } from 'fhir-r4/resources'
import type { FileImporterDescriptor } from 'importer-fundamentals'

import { decodeDicom } from './decode.ts'
import { detectDicom } from './detect.ts'
import { defaultDicomSettings, type DicomSettings } from './settings.ts'
import {
  buildSourceFile,
  DICOM_SOURCE_FILE_CATEGORY_TOKEN,
  DICOM_SOURCE_FILE_CONTENT_TYPE,
  dicomSourceFileFromDocumentReference,
  isDicomSourceFile,
} from './source-file/index.ts'

/**
 * The concrete {@link FileImporterDescriptor} for the `dicom` format: a `.dcm`
 * file's raw bytes in, zero extracted resources out (D3 fills the sections
 * in). Persistence is shell-owned — every FHIR-targeting importer writes
 * through one shared `POST /` batch bundle (`persistBatchBundle` in
 * `fhir-r4/clients`), so no format brings its own `persist`.
 *
 * @remarks
 * `decode` yields zero sections and one note — this format reads no DICOM tags
 * yet — so a confirm writes only the source file `DocumentReference`
 * and nothing else.
 */
const dicomImporterDescriptor: FileImporterDescriptor<DicomSettings, FhirResource> = {
  format: 'dicom',
  display: {
    title: 'DICOM image',
    description: 'Import a DICOM (.dcm) file.',
  },
  detect: detectDicom,
  defaultSettings: defaultDicomSettings,
  decode: decodeDicom,
  buildSourceFile,
  sourceFileCategoryToken: DICOM_SOURCE_FILE_CATEGORY_TOKEN,
  isSourceFile: isDicomSourceFile,
  sourceFileFromDocumentReference: (resource) =>
    dicomSourceFileFromDocumentReference(resource).pipe(
      Effect.map((sourceFile) => ({ fileName: sourceFile.fileName, bytes: sourceFile.bytes }))
    ),
  sourceFileContentType: DICOM_SOURCE_FILE_CONTENT_TYPE,
}

export { dicomImporterDescriptor }
