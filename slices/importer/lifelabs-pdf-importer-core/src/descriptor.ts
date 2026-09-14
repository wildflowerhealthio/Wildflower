import { Effect } from 'effect'
import type { FhirResource } from 'fhir-r4/resources'
import type { FileImporterDescriptor } from 'importer-fundamentals'

import { decodeLifeLabsPdf } from './decode.ts'
import { detectLifeLabsPdf } from './detect.ts'
import { defaultLifeLabsPdfSettings, type LifeLabsPdfSettings } from './settings.ts'
import {
  buildSourceFile,
  isLifeLabsPdfSourceFile,
  LIFELABS_PDF_SOURCE_FILE_CATEGORY_TOKEN,
  LIFELABS_PDF_SOURCE_FILE_CONTENT_TYPE,
  lifeLabsPdfSourceFileFromDocumentReference,
} from './source-file/index.ts'

/**
 * The concrete {@link FileImporterDescriptor} for the `lifelabs-pdf` format:
 * a LifeLabs report's positioned text in, FHIR resources out. Persistence is
 * shell-owned — every FHIR-targeting importer writes through one shared
 * `POST /` batch bundle (`persistBatchBundle` in `fhir-r4/clients`), so no
 * format brings its own `persist`.
 *
 * @remarks
 * `decode` yields one section per report the PDF carries and no notes — this
 * format has no routing decisions (no per-URL kind picks, no source toggles),
 * so every resource the decode yields is a review candidate.
 */
const lifeLabsPdfImporterDescriptor: FileImporterDescriptor<LifeLabsPdfSettings, FhirResource> = {
  format: 'lifelabs-pdf',
  display: {
    title: 'LifeLabs report',
    description: 'Import lab results from a LifeLabs report PDF.',
  },
  detect: detectLifeLabsPdf,
  defaultSettings: defaultLifeLabsPdfSettings,
  decode: decodeLifeLabsPdf,
  buildSourceFile,
  sourceFileCategoryToken: LIFELABS_PDF_SOURCE_FILE_CATEGORY_TOKEN,
  isSourceFile: isLifeLabsPdfSourceFile,
  sourceFileFromDocumentReference: (resource) =>
    lifeLabsPdfSourceFileFromDocumentReference(resource).pipe(
      Effect.map((sourceFile) => ({ fileName: sourceFile.fileName, bytes: sourceFile.bytes }))
    ),
  sourceFileContentType: LIFELABS_PDF_SOURCE_FILE_CONTENT_TYPE,
}

export { lifeLabsPdfImporterDescriptor }
