/**
 * The FHIR synthesis on its own: the parsed `Report` model's types,
 * `toFhirResources`, {@link resourcesWithSourceIdsOf} — each synthesized
 * resource beside its source id under {@link LIFELABS_SYSTEM_FAMILY}, the
 * records a decode yields — and {@link adoptedResourcesOf}, those records
 * adopted as the import stage adopts them, without the PDF extraction the main
 * entry's decode requires.
 *
 * @remarks
 * For callers that build `Report` values themselves rather than reading them
 * off a PDF, such as `synthetic-data-lifelabs`. Only the synthesis: the
 * importer's settings and source-system constants are the main entry's (and
 * `LIFELABS_SYSTEM` also `/source-file`'s).
 *
 * @packageDocumentation
 */
import {
  adoptUnderKey,
  type ResourceWithSourceId,
  SystemFamily,
  withSourceId,
} from '@wildflowerhealthio/fhir-r4-adoption'
import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { Effect, type ParseResult } from 'effect'

import type * as Report from './entities/report.ts'
import { type ReportResources, type SynthesisOptions, toFhirResources } from './fhir/to-fhir.ts'
import { LIFELABS_SYSTEM } from './source-system.ts'

/** The systems LifeLabs keys its records in: `LIFELABS_SYSTEM`, whatever the type. */
const LIFELABS_SYSTEM_FAMILY = SystemFamily.FixedAcrossResourceTypes({ system: LIFELABS_SYSTEM })

/** One report's resources, each beside the source id it is adopted under. */
interface ReportResourcesWithSourceIds extends Omit<ReportResources, 'resources'> {
  readonly resources: readonly ResourceWithSourceId[]
}

/** One report's resources adopted: each under the id it is written to. */
interface AdoptedReportResources extends Omit<ReportResources, 'resources'> {
  readonly resources: readonly FhirResourceWithId[]
}

/**
 * Each report's resources as a decode yields them: synthesized
 * ({@link toFhirResources}), each beside its source id in
 * {@link LIFELABS_SYSTEM_FAMILY} (`withSourceId`).
 *
 * @param reports - The parsed reports, in print order
 * @param options - The zone the reports' printed clock is in
 * @returns One group per report, in report order; fails with a `ParseError`
 *   when a synthesized resource does not satisfy its `fhir-r4` schema
 */
const resourcesWithSourceIdsOf = (
  reports: readonly Report.Type[],
  options: SynthesisOptions
): Effect.Effect<readonly ReportResourcesWithSourceIds[], ParseResult.ParseError> => {
  const keyed = withSourceId(LIFELABS_SYSTEM_FAMILY)
  return Effect.map(toFhirResources(reports, options), (groups) =>
    groups.map((group) => ({ ...group, resources: group.resources.map(keyed) }))
  )
}

/**
 * Each report's resources as an import writes them:
 * {@link resourcesWithSourceIdsOf}, each adopted under its key
 * (`adoptUnderKey`), as the import stage adopts a decode's records.
 *
 * @remarks
 * For a generator that writes what a LifeLabs import would without going
 * through one: no source file, no `meta.source`.
 */
const adoptedResourcesOf = (
  reports: readonly Report.Type[],
  options: SynthesisOptions
): Effect.Effect<readonly AdoptedReportResources[], ParseResult.ParseError> => {
  const adopt = adoptUnderKey(LIFELABS_SYSTEM_FAMILY)
  return Effect.map(resourcesWithSourceIdsOf(reports, options), (groups) =>
    groups.map((group) => ({ ...group, resources: group.resources.map(adopt) }))
  )
}

export {
  type AdoptedReportResources,
  adoptedResourcesOf,
  LIFELABS_SYSTEM_FAMILY,
  type ReportResourcesWithSourceIds,
  resourcesWithSourceIdsOf,
}
export type { Type as ReportGroup } from './entities/group.ts'
export type { Type as ReportLab } from './entities/lab.ts'
export type { Type as ReportPatient } from './entities/patient.ts'
export type { Type as LifeLabsReport } from './entities/report.ts'
export type { Type as ReportSection } from './entities/section.ts'
export type { Type as ReportRow } from './entities/test-table-row.ts'
export { toFhirResources, type ReportResources, type SynthesisOptions } from './fhir/to-fhir.ts'
