import { FileImporter } from 'importer-fundamentals'

import { detectDicom } from './detect.ts'
import { decodeDicomBatch } from './dicom-decode.ts'
import { defaultDicomSettings } from './settings.ts'
import { DICOM_SOURCE_FILE_CODE, DICOM_SYSTEM } from './source-system.ts'

const format = 'dicom'

const display = {
  title: 'DICOM image',
  description: 'Import a DICOM (.dcm) study — pick every file of it, or its folder.',
}
const sourceFileFormat = {
  coding: { system: DICOM_SYSTEM, code: DICOM_SOURCE_FILE_CODE },
  contentType: 'application/dicom',
  descriptionPrefix: `${display.title}: `,
}

const dicomImporter = FileImporter.make({
  display,
  sourceFileFormat,
  format,
  decode: decodeDicomBatch,
  detect: detectDicom,
  defaultSettings: defaultDicomSettings,
})

export { dicomImporter }
