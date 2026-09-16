/**
 * The concrete {@link FileImporterDescriptor} for the `dicom` format: a
 * picked `.dcm` file in, Patient / ServiceRequest / ImagingStudy out.
 *
 * @remarks
 * `decode` is `perFileDecode` over {@link decodeDicom}, so the shared helper
 * mints each local pick's source-file `DocumentReference`, lists it as its
 * own "Source file" section, and hands its id to the decode — which is what
 * the `ImagingStudy` instance names as its `gridfsFileId`. The one
 * format-specific knob is {@link patientSubjectOf}: the minted source file
 * links to the Patient the DICOM header identifies, so the raw file rides
 * along in that patient's record.
 *
 * @packageDocumentation
 */
import { parseDicomFile } from 'dicom'
import { Effect, Either } from 'effect'
import { localResourceId } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import { perFileDecode, type FileImporterDescriptor, type PickedFile } from 'importer-fundamentals'

import { decodeDicom } from './decode.ts'
import { detectDicom } from './detect.ts'
import { patientOriginalId } from './fhir/to-fhir.ts'
import { defaultDicomSettings, type DicomSettings } from './settings.ts'
import {
  DICOM_SOURCE_FILE_CATEGORY_TOKEN,
  DICOM_SOURCE_FILE_CONTENT_TYPE,
  dicomSourceFileCodec,
  dicomSourceFileFromDocumentReference,
  isDicomSourceFile,
} from './source-file/index.ts'
import { DICOM_SYSTEM } from './source-system.ts'

/**
 * The `subject` a picked DICOM file's minted source file links to: the
 * Patient its header identifies, under the same deterministic id the decode's
 * synthesized `Patient` carries.
 *
 * @param file - The picked `.dcm` file
 * @returns The `Patient/<id>` reference, or `undefined` when the bytes are
 *   not DICOM or the header carries no patient identity
 *
 * @remarks
 * Unreadable bytes yield `undefined` rather than a failure: the decode
 * reports the malformed file as an `unreadable` unit, and a missing subject
 * on a source file nobody mints is not a second error to report.
 */
const patientSubjectOf = (file: PickedFile): { readonly reference: string } | undefined => {
  const parseResult = parseDicomFile(file.bytes)
  if (Either.isLeft(parseResult)) return undefined
  const originalId = patientOriginalId(parseResult.right)
  if (originalId === undefined) return undefined
  return { reference: `Patient/${localResourceId(DICOM_SYSTEM, 'Patient', originalId)}` }
}

const dicomImporterDescriptor: FileImporterDescriptor<DicomSettings, FhirResource> = {
  format: 'dicom',
  display: {
    title: 'DICOM image',
    description: 'Import a DICOM (.dcm) file.',
  },
  detect: detectDicom,
  defaultSettings: defaultDicomSettings,
  decode: perFileDecode(dicomSourceFileCodec, decodeDicom, { subjectFor: patientSubjectOf }),
  sourceFileCategoryToken: DICOM_SOURCE_FILE_CATEGORY_TOKEN,
  isSourceFile: isDicomSourceFile,
  sourceFileFromDocumentReference: (resource) =>
    dicomSourceFileFromDocumentReference(resource).pipe(
      Effect.map((sourceFile) => ({ fileName: sourceFile.fileName, bytes: sourceFile.bytes }))
    ),
  sourceFileContentType: DICOM_SOURCE_FILE_CONTENT_TYPE,
}

export { dicomImporterDescriptor, patientSubjectOf }
