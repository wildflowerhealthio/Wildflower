/**
 * The LifeLabs PDF binding of the importer slice (core layer): the
 * positioned-text dialect that reads a LifeLabs "Reports" PDF's pages into
 * structured lab reports, the FHIR R4 synthesis, the importer descriptor, and
 * the decode/persist integration.
 *
 * @remarks
 * No DOM, no `fs`, no React: a `wildflower-positioned-text` document in,
 * typed `LifeLabsReport` records out, FHIR resources synthesized, and an
 * opt-in write behind the descriptor's `persist`.
 *
 * @packageDocumentation
 */
export { decodeLifeLabsPdf, decodeLifeLabsPdfDocument, reportSectionTitle } from './decode.ts'
export { detectLifeLabsPdf } from './detect.ts'
export { lifeLabsPdfImporterDescriptor } from './descriptor.ts'
export { sourceArchive } from './archive/index.ts'
export * as Report from './entities/report.ts'
export type { Type as ReportGroup } from './entities/group.ts'
export type { Type as ReportLab } from './entities/lab.ts'
export type { Type as ReportPatient } from './entities/patient.ts'
export type { Type as LifeLabsReport } from './entities/report.ts'
export type { Type as ReportSection } from './entities/section.ts'
export type { Type as ReportRow } from './entities/test-table-row.ts'
export { toFhirResources, type ReportResources, type SynthesisOptions } from './fhir/to-fhir.ts'
export { defaultLifeLabsPdfSettings, type LifeLabsPdfSettings } from './settings.ts'
export { LIFELABS_SYSTEM, LifeLabsIdentifierSystem } from './source-system.ts'
