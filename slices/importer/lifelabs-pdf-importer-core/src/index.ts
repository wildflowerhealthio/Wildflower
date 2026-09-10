/**
 * The LifeLabs PDF binding of the importer slice (core layer): the
 * positioned-text dialect that reads a LifeLabs "Reports" PDF's pages into
 * structured lab reports, and the FHIR R4 synthesis that converts them to
 * standard resources.
 *
 * @remarks
 * No DOM, no `fs`, no React: a `wildflower-positioned-text` document in,
 * typed `LifeLabsReport` records out, FHIR resources synthesized.
 *
 * @packageDocumentation
 */
export * as Report from './entities/report.ts'
export type { Type as ReportGroup } from './entities/group.ts'
export type { Type as ReportLab } from './entities/lab.ts'
export type { Type as ReportPatient } from './entities/patient.ts'
export type { Type as LifeLabsReport } from './entities/report.ts'
export type { Type as ReportSection } from './entities/section.ts'
export type { Type as ReportRow } from './entities/test-table-row.ts'
export { toFhirResources, type SynthesisOptions } from './fhir/to-fhir.ts'
export { defaultLifeLabsPdfSettings, type LifeLabsPdfSettings } from './settings.ts'
export { LIFELABS_SYSTEM, LifeLabsIdentifierSystem } from './source-system.ts'
