/**
 * The FHIR synthesis on its own: the parsed `Report` model's types,
 * `toFhirResources`, and {@link decodedReportsOf} — the reports as the
 * LifeLabs decode yields them, one section per report, each synthesized
 * resource detached, keyed in `LIFELABS_SYSTEM` — without the PDF extraction
 * the main entry's decode requires.
 *
 * @remarks
 * For callers that build `Report` values themselves rather than reading them
 * off a PDF, such as `synthetic-data-lifelabs`. Only the synthesis: the
 * importer's settings and source-system constants are the main entry's (and
 * `LIFELABS_SYSTEM` also `/source-file`'s).
 *
 * @packageDocumentation
 */
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { DecodedFileSet, type DecodeFunction } from '@wildflowerhealthio/importer-fundamentals'
import { Effect, Option, type ParseResult } from 'effect'

import type * as Report from './entities/report.ts'
import { type SynthesisOptions, toFhirResources } from './fhir/to-fhir.ts'

/**
 * A detached record as its review row: keyed by its type and its key's value
 * (the source id the synthesis gave it), which a settings re-decode keeps, and
 * titled by the reference it is written under, `<Type>/<local id>`.
 *
 * @remarks
 * The synthesis gives every record an id, so every record is keyed. A keyless
 * one would be reviewed under its type and its position in the report,
 * `<Type>#<index>`, which a re-decode of the same print also keeps.
 */
const reportEntryOf = (resource: DetachedResource.Type, index: number): DecodedFileSet.Entry => {
  const key = Option.match(DetachedResource.keyOf(resource), {
    onSome: ({ value }) => `${resource.resourceType}/${value}`,
    onNone: () => `${resource.resourceType}#${index}`,
  })
  return { key, title: DecodedFileSet.writtenReferenceTitle(resource, key), resource }
}

/**
 * The section title one report's resources are reviewed under: the report's
 * own printed identity — its `Lab No` and date of service — with a generic
 * fallback when the report masks both.
 */
const reportSectionTitle = (report: Report.Type): string => {
  const labNo = report.labNo.trim()
  const dateOfService = report.dateOfService.trim()
  const parts = [labNo === '' ? '' : `Lab No ${labNo}`, dateOfService].filter((part) => part !== '')
  return parts.length === 0 ? 'LifeLabs report' : parts.join(' — ')
}

/**
 * The reports as the LifeLabs decode yields them: one section per report, its
 * records detached and keyed in `LIFELABS_SYSTEM`, each reviewed as
 * `<Type>/<source id>` and titled by the reference it is written under, no
 * notes.
 *
 * @param reports - The parsed reports, in print order
 * @param options - The zone the reports' printed clock is in
 * @returns The set's decode, for the import stage to adopt; fails with a
 *   `ParseError` when a synthesized resource does not satisfy its `fhir-r4`
 *   schema
 *
 * @remarks
 * The decode's own last leg, after the PDF's text is read into reports. A
 * caller that builds reports itself, such as `synthetic-data-lifelabs`' render,
 * adopts this with `DecodedFileSet.adopt` to get the records an import of their
 * print writes.
 */
const decodedReportsOf = (
  reports: readonly Report.Type[],
  options: SynthesisOptions
): Effect.Effect<DecodeFunction.FileSetDecode, ParseResult.ParseError> =>
  Effect.map(toFhirResources(reports, options), (groups) => ({
    sections: groups.map((group) => ({
      title: reportSectionTitle(group.report),
      entries: group.resources.map(reportEntryOf),
    })),
    notes: [],
  }))

export { decodedReportsOf, reportSectionTitle }
export type { Type as ReportGroup } from './entities/group.ts'
export type { Type as ReportLab } from './entities/lab.ts'
export type { Type as ReportPatient } from './entities/patient.ts'
export type { Type as LifeLabsReport } from './entities/report.ts'
export type { Type as ReportSection } from './entities/section.ts'
export type { Type as ReportRow } from './entities/test-table-row.ts'
export { toFhirResources, type ReportResources, type SynthesisOptions } from './fhir/to-fhir.ts'
