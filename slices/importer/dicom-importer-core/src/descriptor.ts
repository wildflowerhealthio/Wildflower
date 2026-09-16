/**
 * The concrete {@link FileImporterDescriptor} for the `dicom` format.
 * `buildSourceFile` derives a Patient reference from the DICOM header and
 * sets `subject` on the archive `DocumentReference` when `PatientID` is
 * present.
 *
 * @packageDocumentation
 */
import { parseDicomFile } from 'dicom'
import { Effect, Either } from 'effect'
import { localResourceId } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import type { FileImporterDescriptor } from 'importer-fundamentals'

import { decodeDicom } from './decode.ts'
import { detectDicom } from './detect.ts'
import { patientOriginalId } from './fhir/to-fhir.ts'
import { defaultDicomSettings, type DicomSettings } from './settings.ts'
import {
  buildSourceFile as buildSourceFileRaw,
  DICOM_SOURCE_FILE_CATEGORY_TOKEN,
  DICOM_SOURCE_FILE_CONTENT_TYPE,
  dicomSourceFileFromDocumentReference,
  isDicomSourceFile,
} from './source-file/index.ts'
import { DICOM_SYSTEM } from './source-system.ts'

const dicomImporterDescriptor: FileImporterDescriptor<DicomSettings, FhirResource> = {
  format: 'dicom',
  display: {
    title: 'DICOM image',
    description: 'Import a DICOM (.dcm) file.',
  },
  detect: detectDicom,
  defaultSettings: defaultDicomSettings,
  decode: decodeDicom,
  buildSourceFile: (picked, _options) => {
    const parseResult = parseDicomFile(picked.bytes)
    let subject: { reference: string } | undefined
    if (Either.isRight(parseResult)) {
      const header = parseResult.right
      const patId = patientOriginalId(header)
      if (patId !== undefined) {
        const localId = localResourceId(DICOM_SYSTEM, 'Patient', patId)
        subject = { reference: `Patient/${localId}` }
      }
    }
    return buildSourceFileRaw(picked, { subject })
  },
  sourceFileCategoryToken: DICOM_SOURCE_FILE_CATEGORY_TOKEN,
  isSourceFile: isDicomSourceFile,
  sourceFileFromDocumentReference: (resource) =>
    dicomSourceFileFromDocumentReference(resource).pipe(
      Effect.map((sourceFile) => ({ fileName: sourceFile.fileName, bytes: sourceFile.bytes }))
    ),
  sourceFileContentType: DICOM_SOURCE_FILE_CONTENT_TYPE,
}

export { dicomImporterDescriptor }
