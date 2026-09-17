import { Effect } from 'effect'
import type { FhirResource } from 'fhir-r4/resources'
import { SourceFile, type FileImporterDescriptor } from 'importer-fundamentals'

import { decodeLifeLabsPdf } from './decode.ts'
import { detectLifeLabsPdf } from './detect.ts'
import { defaultLifeLabsPdfSettings, type LifeLabsPdfSettings } from './settings.ts'
import {
  isLifeLabsPdfSourceFile,
  LIFELABS_PDF_SOURCE_FILE_CATEGORY_TOKEN,
  LIFELABS_PDF_SOURCE_FILE_CONTENT_TYPE,
  lifeLabsPdfSourceFileCodec,
  lifeLabsPdfSourceFileFromDocumentReference,
} from './source-file/index.ts'

/**
 * The concrete {@link FileImporterDescriptor} for the `lifelabs-pdf` format:
 * a LifeLabs report's positioned text in, FHIR resources out. Persistence is
 * shell-owned — every FHIR-targeting importer writes through one shared
 * `POST /` batch bundle (`persistBatchBundle` in `fhir-r4/clients`), so no
 * format brings its own write sink.
 *
 * @remarks
 * `decode` yields one section per report the PDF carries and no notes — this
 * format has no routing decisions (no per-URL kind picks, no source toggles),
 * so every resource the decode yields is a review candidate. It is
 * {@link decodeLifeLabsPdf} lifted through `perFileDecode` with this format's
 * source-file codec, so a `local` pick's source-file `DocumentReference` is
 * minted inside the decode, reviewed as its own "Source file" section, and
 * stamped onto every synthesized resource's `meta.source`; a `server` pick
 * mints nothing and stamps the reference it came with.
 */
const lifeLabsPdfImporterDescriptor: FileImporterDescriptor<LifeLabsPdfSettings, FhirResource> = {
  format: 'lifelabs-pdf',
  display: {
    title: 'LifeLabs report',
    description: 'Import lab results from a LifeLabs report PDF.',
  },
  detect: detectLifeLabsPdf,
  defaultSettings: defaultLifeLabsPdfSettings,
  decode: SourceFile.perFileDecode(lifeLabsPdfSourceFileCodec, decodeLifeLabsPdf),
  sourceFileCategoryToken: LIFELABS_PDF_SOURCE_FILE_CATEGORY_TOKEN,
  isSourceFile: isLifeLabsPdfSourceFile,
  sourceFileFromDocumentReference: (resource) =>
    lifeLabsPdfSourceFileFromDocumentReference(resource).pipe(
      Effect.map((sourceFile) => ({ fileName: sourceFile.fileName, bytes: sourceFile.bytes }))
    ),
  sourceFileContentType: LIFELABS_PDF_SOURCE_FILE_CONTENT_TYPE,
}

export { lifeLabsPdfImporterDescriptor }
