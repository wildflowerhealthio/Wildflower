/**
 * The LifeLabs PDF binding of the importer slice (core layer): the
 * positioned-text dialect that reads a LifeLabs "Reports" PDF's pages into
 * structured lab reports.
 *
 * @remarks
 * No DOM, no `fs`, no React: a `wildflower-positioned-text` document in,
 * typed `LifeLabsReport` records out. The FHIR synthesis, decode binding, and
 * importer descriptor are added in a follow-up.
 *
 * @packageDocumentation
 */
export { parseReports } from './dialect/parse-report.ts'
export type {
  LifeLabsReport,
  ReportGroup,
  ReportLab,
  ReportPatient,
  ReportRow,
  ReportSection,
} from './dialect/report.ts'
export { defaultLifeLabsPdfSettings, type LifeLabsPdfSettings } from './settings.ts'
