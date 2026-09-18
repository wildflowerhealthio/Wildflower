import { DecodedFile, FileImporter, type SourceFile, DecodeFunction } from 'importer-fundamentals'

import { decodeDicom } from './decode.ts'
import { detectDicom } from './detect.ts'
import { defaultDicomSettings } from './settings.ts'
import { DICOM_SOURCE_FILE_CODE, DICOM_SYSTEM } from './source-system.ts'

/**
 * File the raw image under the patient the decode extracted, so the bytes ride
 * along in that patient's record.
 *
 * @remarks
 * Reads the `Patient` off the decode's own resources rather than re-parsing the
 * file: `decodeDicom` has already parsed the header and adopted the patient
 * under {@link DICOM_SYSTEM}, so its id is the one a second parse would derive.
 * A header naming no patient decodes to no `Patient`, and gets no subject.
 */
const patientSubjectOf: SourceFile.SubjectFor = (_file, decoded) => {
  const patient = DecodedFile.resources(decoded).find(
    (entry) => entry.resource.resourceType === 'Patient'
  )
  const id = patient?.resource.id
  if (id === undefined || id === null) return undefined
  return { reference: `Patient/${id}` }
}

const format = 'dicom'

const display = {
  title: 'DICOM image',
  description: 'Import a DICOM (.dcm) file.',
}
const sourceFileFormat = {
  coding: { system: DICOM_SYSTEM, code: DICOM_SOURCE_FILE_CODE },
  contentType: 'application/dicom',
  descriptionPrefix: `${display.title}: `,
}
const decodeFunctionConfig = {
  format,
  decodeOne: decodeDicom,
  subjectFor: patientSubjectOf,
} as const

const dicomImporter = FileImporter.make({
  display,
  sourceFileFormat,
  format,
  decode: DecodeFunction.fromCombinableDecodeConfig(decodeFunctionConfig, sourceFileFormat),
  detect: detectDicom,
  defaultSettings: defaultDicomSettings,
})

export { dicomImporter, patientSubjectOf }
