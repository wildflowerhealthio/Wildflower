/**
 * The LifeLabs PDF binding of the importer slice: the concrete
 * `FileImporterDescriptor` for format `'lifelabs-pdf'`, assembled from the
 * positioned-text dialect, the FHIR R4 synthesis, one response kind, and the
 * FHIR persist sink.
 *
 * @remarks
 * No DOM, no `fs`, no React: a `wildflower-positioned-text` document in, FHIR
 * resources out, an opt-in write behind {@link lifeLabsPdfImporterDescriptor}'s
 * `persist`.
 *
 * @packageDocumentation
 */
export { lifeLabsPdfImporterDescriptor } from './descriptor.ts'
export { decodeLifeLabsPdf, LIFELABS_PDF_URL_PREFIX, TIME_ZONE_HEADER } from './decode.ts'
export { parseReports } from './dialect/parse-report.ts'
export type {
  LifeLabsReport,
  ReportGroup,
  ReportLab,
  ReportPatient,
  ReportRow,
  ReportSection,
} from './dialect/report.ts'
export { toFhirResources, type SynthesisOptions } from './fhir/to-fhir.ts'
export { persistFhir } from './persist-fhir.ts'
export { LifeLabsReportResponseKind, lifeLabsPdfResponseKinds } from './response-kind.ts'
export { defaultLifeLabsPdfSettings, type LifeLabsPdfSettings } from './settings.ts'
export { lifeLabsPdfSource } from './source.ts'
export { LIFELABS_SYSTEM, LifeLabsIdentifierSystem } from './source-system.ts'
