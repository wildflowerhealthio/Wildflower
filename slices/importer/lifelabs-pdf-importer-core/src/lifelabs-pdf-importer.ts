import { FileImporter, PerFileDecodeFunction } from 'importer-fundamentals'

import { decodeLifeLabsPdf } from './decode.ts'
import { detectLifeLabsPdf } from './detect.ts'
import { defaultLifeLabsPdfSettings } from './settings.ts'
import { LIFELABS_PDF_SOURCE_FILE_CODE, LIFELABS_SYSTEM } from './source-system.ts'

const format = 'lifelabs-pdf'

const display = {
  title: 'LifeLabs report',
  description: 'Import lab results from a LifeLabs report PDF.',
}
const sourceFileFormat = {
  coding: { system: LIFELABS_SYSTEM, code: LIFELABS_PDF_SOURCE_FILE_CODE },
  contentType: 'application/pdf',
  descriptionPrefix: `${display.title}: `,
}
const decodeConfig = {
  format,
  decodeOne: decodeLifeLabsPdf,
} as const

const lifeLabsPdfImporter = FileImporter.make({
  format,
  display,
  sourceFileFormat,
  decode: PerFileDecodeFunction.make(decodeConfig),
  detect: detectLifeLabsPdf,
  defaultSettings: defaultLifeLabsPdfSettings,
})

export { lifeLabsPdfImporter }
