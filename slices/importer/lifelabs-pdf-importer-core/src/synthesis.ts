/**
 * The FHIR synthesis on its own: the parsed `Report` model's types,
 * `toFhirResources`, and {@link decodedReportsOf} — the reports as the
 * LifeLabs decode yields them, one `FromSource` section per report, each
 * synthesized resource beside its source id under
 * {@link LIFELABS_SYSTEM_FAMILY} — without the PDF extraction the main entry's
 * decode requires.
 *
 * @remarks
 * For callers that build `Report` values themselves rather than reading them
 * off a PDF, such as `synthetic-data-lifelabs`. Only the synthesis: the
 * importer's settings and source-system constants are the main entry's (and
 * `LIFELABS_SYSTEM` also `/source-file`'s).
 *
 * @packageDocumentation
 */
import { type ResourceWithSourceId, SystemFamily } from '@wildflowerhealthio/fhir-r4-adoption'
import { DecodedFileSet, type DecodeFunction } from '@wildflowerhealthio/importer-fundamentals'
import { Effect, type ParseResult } from 'effect'

import type * as Report from './entities/report.ts'
import { type SynthesisOptions, toFhirResources } from './fhir/to-fhir.ts'
import { LIFELABS_SYSTEM } from './source-system.ts'

/** The systems LifeLabs keys its records in: `LIFELABS_SYSTEM`, whatever the type. */
const LIFELABS_SYSTEM_FAMILY = SystemFamily.FixedAcrossResourceTypes({ system: LIFELABS_SYSTEM })

/** A record as its review row, keyed and titled by its type and source id. */
const labelWithSourceId = (record: ResourceWithSourceId): DecodedFileSet.ReviewLabel => {
  const typeAndSourceId = `${record.resource.resourceType}/${record.sourceId}`
  return { key: typeAndSourceId, title: typeAndSourceId }
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
 * The reports as the LifeLabs decode yields them: one `FromSource` section per
 * report, under {@link LIFELABS_SYSTEM_FAMILY}, each record keyed and titled
 * `<Type>/<source id>`, no notes.
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
    sections: groups.map((group) =>
      DecodedFileSet.fromSourceSection({
        systemFamily: LIFELABS_SYSTEM_FAMILY,
        title: reportSectionTitle(group.report),
        resources: group.resources,
        labelOf: labelWithSourceId,
      })
    ),
    notes: [],
  }))

export { decodedReportsOf, LIFELABS_SYSTEM_FAMILY, reportSectionTitle }
export type { Type as ReportGroup } from './entities/group.ts'
export type { Type as ReportLab } from './entities/lab.ts'
export type { Type as ReportPatient } from './entities/patient.ts'
export type { Type as LifeLabsReport } from './entities/report.ts'
export type { Type as ReportSection } from './entities/section.ts'
export type { Type as ReportRow } from './entities/test-table-row.ts'
export { toFhirResources, type ReportResources, type SynthesisOptions } from './fhir/to-fhir.ts'
