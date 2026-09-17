import { fileImporter } from 'importer-fundamentals'

import { decodeLifeLabsPdf } from './decode.ts'
import { detectLifeLabsPdf } from './detect.ts'
import { defaultLifeLabsPdfSettings } from './settings.ts'
import { LIFELABS_PDF_SOURCE_FILE_CODE, LIFELABS_SYSTEM } from './source-system.ts'

const lifeLabsPdfImporter = fileImporter({
  format: 'lifelabs-pdf',
  coding: { system: LIFELABS_SYSTEM, code: LIFELABS_PDF_SOURCE_FILE_CODE },
  contentType: 'application/pdf',
  display: {
    title: 'LifeLabs report',
    description: 'Import lab results from a LifeLabs report PDF.',
  },
  detect: detectLifeLabsPdf,
  defaultSettings: defaultLifeLabsPdfSettings,
  decodeOne: decodeLifeLabsPdf,
})

export { lifeLabsPdfImporter }
