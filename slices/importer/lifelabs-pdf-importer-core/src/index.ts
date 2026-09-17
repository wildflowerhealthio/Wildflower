/**
 * The LifeLabs PDF binding of the importer slice (core layer): the
 * positioned-text dialect that reads a LifeLabs "Reports" PDF's pages into
 * structured lab reports, the FHIR R4 synthesis, and the format's importer.
 *
 * @remarks
 * No DOM, no `fs`, no React: a `wildflower-positioned-text` document in,
 * typed `LifeLabsReport` records out, and FHIR resources synthesized for the
 * shell's review — the opt-in write is the shell's own `persistBatchBundle`,
 * not a field on this format's importer.
 *
 * @packageDocumentation
 */
export { decodeLifeLabsPdf, decodeLifeLabsPdfDocument, reportSectionTitle } from './decode.ts'
export { detectLifeLabsPdf } from './detect.ts'
export { lifeLabsPdfImporter } from './descriptor.ts'
export * as Report from './entities/report.ts'
export type { Type as ReportGroup } from './entities/group.ts'
export type { Type as ReportLab } from './entities/lab.ts'
export type { Type as ReportPatient } from './entities/patient.ts'
export type { Type as LifeLabsReport } from './entities/report.ts'
export type { Type as ReportSection } from './entities/section.ts'
export type { Type as ReportRow } from './entities/test-table-row.ts'
export { toFhirResources, type ReportResources, type SynthesisOptions } from './fhir/to-fhir.ts'
export { defaultLifeLabsPdfSettings, type LifeLabsPdfSettings } from './settings.ts'
export {
  LIFELABS_PDF_SOURCE_FILE_CODE,
  LIFELABS_PDF_SOURCE_FILE_CONTENT_TYPE,
  LIFELABS_SYSTEM,
  LifeLabsIdentifierSystem,
} from './source-system.ts'
