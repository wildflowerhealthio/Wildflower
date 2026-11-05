/**
 * The FHIR synthesis on its own: the parsed `Report` model's types and the
 * `LabNumber` a report is built with, `toFhirResources`, and
 * {@link decodedReportsOf} — the reports as the
 * LifeLabs decode yields them, one section per report, each synthesized
 * resource detached and keyed by an identifier the report prints — without
 * the PDF extraction the main entry's decode requires.
 *
 * @remarks
 * For callers that build `Report` values themselves rather than reading them
 * off a PDF, such as `synthetic-data-lifelabs`. Only the synthesis: the
 * importer's settings and source-system constants are the main entry's (and
 * the source-file ones also `/source-file`'s).
 *
 * @packageDocumentation
 */
import type { DecodeFunction } from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Effect, type ParseResult } from 'effect'

import type * as Report from './entities/report.ts'
import { keptPrintingNote, latestPrintingOf, printingsByLabNo } from './fhir/printings.ts'
import { type SynthesisOptions, toFhirResources } from './fhir/to-fhir.ts'

/**
 * The section title one report's resources are reviewed under: the report's
 * own printed identity — its `Lab No`, and its date of service when it
 * prints one.
 */
const reportSectionTitle = (report: Report.Type): string => {
  const dateOfService = report.dateOfService.trim()
  return [`Lab No ${report.labNo}`, dateOfService].filter((part) => part !== '').join(' — ')
}

/**
 * The reports as the LifeLabs decode yields them: one section per `Lab No`,
 * in the order each is first printed, its records detached and keyed by the
 * identifiers the report prints, each
 * entry's `fullUrl` `<Type>/<key value>`, and a note for each `Lab No`
 * printed more than once.
 *
 * @param reports - The parsed reports, in print order
 * @param options - The zone the reports' printed clock is in
 * @returns The set's decode, for the import stage to adopt; fails with a
 *   `ParseError` when a synthesized resource does not satisfy its `fhir-r4`
 *   schema
 *
 * @remarks
 * The decode's own last leg, after the PDF's text is read into reports. A
 * `Lab No` printed more than once is one report: only its latest printing
 * (`latestPrintingOf`) is synthesized, so every record of the set has its own
 * key. A caller that builds reports itself, such as `synthetic-data-lifelabs`'
 * render, adopts this with `DecodedFileSet.adopt` to get the records an import
 * of their print writes.
 */
const decodedReportsOf = (
  reports: readonly Report.Type[],
  options: SynthesisOptions
): Effect.Effect<DecodeFunction.FileSetDecode, ParseResult.ParseError> => {
  const printingsOfEachLabNo = printingsByLabNo(reports)
  const latestPrintings = printingsOfEachLabNo.map((printings) =>
    latestPrintingOf(printings, options.timeZone)
  )
  return Effect.map(toFhirResources(latestPrintings, options), (groups) => ({
    sections: groups.map((group) => ({
      title: reportSectionTitle(group.report),
      entries: group.entries,
    })),
    notes: Arr.zip(printingsOfEachLabNo, latestPrintings)
      .filter(([printings]) => printings.length > 1)
      .map(([printings, latestPrinting]) => keptPrintingNote(printings, latestPrinting)),
  }))
}

export { decodedReportsOf, reportSectionTitle }
export * as LabNumber from './entities/lab-number.ts'
export type { Type as ReportGroup } from './entities/group.ts'
export type { Type as ReportLab } from './entities/lab.ts'
export type { Type as ReportPatient } from './entities/patient.ts'
export type { Type as LifeLabsReport } from './entities/report.ts'
export type { Type as ReportSection } from './entities/section.ts'
export type { Type as ReportRow } from './entities/test-table-row.ts'
export { toFhirResources, type ReportResources, type SynthesisOptions } from './fhir/to-fhir.ts'
