import { DecodeFunction, type FileImporter } from 'importer-fundamentals'

import { decodeLifeLabsPdf } from './decode.ts'
import { detectLifeLabsPdf } from './detect.ts'
import { defaultLifeLabsPdfSettings, type LifeLabsPdfSettings } from './settings.ts'
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

/**
 * The LifeLabs PDF importer: one report PDF per pick.
 *
 * @remarks
 * No `groupBy` — a report stands alone — and no `source file`: the stored PDF is
 * the format's own artifact, kept out of `Patient/$everything`.
 */
const lifeLabsPdfImporter: FileImporter.Type<LifeLabsPdfSettings, typeof format> = {
  format,
  display,
  detect: detectLifeLabsPdf,
  defaultSettings: defaultLifeLabsPdfSettings,
  sourceFileFormat,
  decode: DecodeFunction.make({
    format,
    sourceFileFormat,
    decodeFileSet: (members, settings) => decodeLifeLabsPdf(members[0], settings),
  }),
}

export { lifeLabsPdfImporter }
