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
import { type DecodeFunction, Section } from '@wildflowerhealthio/importer-fundamentals'
import { Effect, type ParseResult } from 'effect'

import type * as Report from './entities/report.ts'
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
 * The reports as the LifeLabs decode yields them: one section per report, its
 * records detached and keyed by the identifiers the report prints, each
 * entry's `fullUrl` `<Type>/<key value>`, no notes.
 *
 * @param reports - The parsed reports, in print order, one per `Lab No`
 * @param options - The zone the reports' printed clock is in, and the province
 *   that issued the health card they print
 * @returns The set's decode, for the import stage to adopt; fails with a
 *   `ParseError` when a report's `HC #` is not the chosen province's shape,
 *   or a synthesized resource does not satisfy its `fhir-r4` schema
 *
 * @remarks
 * The decode's own last leg, after the PDF's text is read into reports, one
 * per `Lab No` (`Report.tryFromDocument`), so every record of the set has its
 * own key. A caller that builds reports itself, such as
 * `synthetic-data-lifelabs`' render, gives each its own `Lab No` too, and
 * adopts this with `DecodedFileSet.adopt` to get the records an import of
 * their print writes.
 */
const decodedReportsOf = (
  reports: readonly Report.Type[],
  options: SynthesisOptions
): Effect.Effect<DecodeFunction.FileSetDecode, ParseResult.ParseError> =>
  Effect.map(toFhirResources(reports, options), (groups) => ({
    sections: groups.map((group) => Section.make(reportSectionTitle(group.report), group.entries)),
    notes: [],
  }))

export { decodedReportsOf, reportSectionTitle }
export * as LabNumber from './entities/lab-number.ts'
export type { Type as ReportGroup } from './entities/group.ts'
export type { Type as ReportLab } from './entities/lab.ts'
export type { Type as ReportPatient } from './entities/patient.ts'
export type { Type as LifeLabsReport } from './entities/report.ts'
export type { Type as ReportSection } from './entities/section.ts'
export type { Type as ReportRow } from './entities/test-table-row.ts'
export { toFhirResources, type ReportResources, type SynthesisOptions } from './fhir/to-fhir.ts'
