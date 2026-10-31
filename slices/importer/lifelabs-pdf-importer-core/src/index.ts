/**
 * The LifeLabs PDF binding of the importer slice: the positioned-text dialect
 * that reads a LifeLabs "Reports" PDF's pages into structured lab reports, the
 * FHIR R4 synthesis, and the format's importer.
 *
 * @remarks
 * Decoding a picked PDF requires `positioned-text`'s `PositionedTextExtractor`,
 * which the host provides (`positioned-text-web`'s pdfjs layer). No DOM code,
 * no `fs`, no React, no extraction library: a `wildflower-positioned-text` document in,
 * typed `LifeLabsReport` records out, and FHIR resources synthesized for the
 * shell's review — the opt-in write is the shell's own `persistBatchBundle`,
 * not a field on this format's importer.
 *
 * @packageDocumentation
 */
export { decodeLifeLabsPdf, decodeLifeLabsPdfDocument, reportSectionTitle } from './decode.ts'
export { detectLifeLabsPdf } from './detect.ts'
export { lifeLabsPdfImporter } from './lifelabs-pdf-importer.ts'
export * as Report from './entities/report.ts'
export { defaultLifeLabsPdfSettings, type LifeLabsPdfSettings } from './settings.ts'
export {
  LIFELABS_PDF_SOURCE_FILE_CODE,
  LIFELABS_PDF_SOURCE_FILE_CONTENT_TYPE,
  LIFELABS_SYSTEM,
  LifeLabsIdentifierSystem,
} from './source-system.ts'
