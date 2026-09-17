import { parseDicomFile } from 'dicom'
import { Either } from 'effect'
import { localResourceId } from 'fhir-r4/identity'
import { FileImporter, type PickedFile } from 'importer-fundamentals'

import { decodeDicom } from './decode.ts'
import { detectDicom } from './detect.ts'
import { patientOriginalId } from './fhir/to-fhir.ts'
import { defaultDicomSettings } from './settings.ts'
import { DICOM_SOURCE_FILE_CODE, DICOM_SYSTEM } from './source-system.ts'

const patientSubjectOf = (file: PickedFile): { readonly reference: string } | undefined => {
  const parseResult = parseDicomFile(file.bytes)
  if (Either.isLeft(parseResult)) return undefined
  const originalId = patientOriginalId(parseResult.right)
  if (originalId === undefined) return undefined
  return { reference: `Patient/${localResourceId(DICOM_SYSTEM, 'Patient', originalId)}` }
}

const dicomImporter = new FileImporter({
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
