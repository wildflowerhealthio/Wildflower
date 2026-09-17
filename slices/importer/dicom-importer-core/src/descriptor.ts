import { DecodedFile, fileImporter, type SourceFile } from 'importer-fundamentals'

import { decodeDicom } from './decode.ts'
import { detectDicom } from './detect.ts'
import { defaultDicomSettings } from './settings.ts'
import { DICOM_SOURCE_FILE_CODE, DICOM_SYSTEM } from './source-system.ts'

/**
 * File the raw image under the patient the decode extracted from the DICOM
 * header, so the bytes ride along in that patient's record.
 *
 * @remarks
 * Reads the `Patient` off the decode's own resources rather than re-parsing
 * the file: `decodeDicom` has already parsed the header, synthesized the
 * patient, and adopted it under {@link DICOM_SYSTEM}, so its id is exactly the
 * one a second parse would derive. A file whose header names no patient
 * decodes to no `Patient` and gets no subject.
 */
const patientSubjectOf: SourceFile.SubjectFor = (_file, decoded) => {
  const patient = DecodedFile.resources(decoded).find(
    (entry) => entry.resource.resourceType === 'Patient'
  )
  const id = patient?.resource.id
  if (id === undefined || id === null) return undefined
  return { reference: `Patient/${id}` }
}

const dicomImporter = fileImporter({
  format: 'dicom',
  coding: { system: DICOM_SYSTEM, code: DICOM_SOURCE_FILE_CODE },
  contentType: 'application/dicom',
  display: {
    title: 'DICOM image',
    description: 'Import a DICOM (.dcm) file.',
  },
  detect: detectDicom,
  defaultSettings: defaultDicomSettings,
  decodeOne: decodeDicom,
  subjectFor: patientSubjectOf,
})

export { dicomImporter, patientSubjectOf }
