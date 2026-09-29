/**
 * The FHIR synthesis on its own: the parsed `Report` model's types,
 * `toFhirResources`, the source system its resources are adopted under and
 * the default time zone a report's clock is read in — without the PDF
 * extraction (`positioned-text-web`, pdfjs) the main entry's decode carries.
 *
 * @remarks
 * For callers that build `Report` values themselves rather than reading them
 * off a PDF, such as `synthetic-data-core`'s LifeLabs renderer.
 *
 * @packageDocumentation
 */
export type { Type as ReportGroup } from './entities/group.ts'
export type { Type as ReportLab } from './entities/lab.ts'
export type { Type as ReportPatient } from './entities/patient.ts'
export type { Type as LifeLabsReport } from './entities/report.ts'
export type { Type as ReportSection } from './entities/section.ts'
export type { Type as ReportRow } from './entities/test-table-row.ts'
export { toFhirResources, type ReportResources, type SynthesisOptions } from './fhir/to-fhir.ts'
export { defaultLifeLabsPdfSettings, type LifeLabsPdfSettings } from './settings.ts'
export { LIFELABS_SYSTEM } from './source-system.ts'
