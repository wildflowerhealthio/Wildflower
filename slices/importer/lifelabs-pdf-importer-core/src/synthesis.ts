/**
 * The FHIR synthesis on its own: the parsed `Report` model's types,
 * `toFhirResources`, and {@link adoptedResourcesOf} — synthesis then adoption
 * under `LIFELABS_SYSTEM`, the resources a decode yields — without the PDF
 * extraction (`positioned-text-web`, pdfjs) the main entry's decode carries.
 *
 * @remarks
 * For callers that build `Report` values themselves rather than reading them
 * off a PDF, such as `synthetic-data-lifelabs`.
 *
 * @packageDocumentation
 */
import { Effect, type ParseResult } from 'effect'
import { adoptResource } from 'fhir-r4/identity'

import type * as Report from './entities/report.ts'
import { type ReportResources, type SynthesisOptions, toFhirResources } from './fhir/to-fhir.ts'
import { LIFELABS_SYSTEM } from './source-system.ts'

const adopt = adoptResource({ system: LIFELABS_SYSTEM })

/**
 * Each report's resources as a decode yields them: synthesized
 * ({@link toFhirResources}), then adopted under {@link LIFELABS_SYSTEM}.
 *
 * @param reports - The parsed reports, in print order
 * @param options - The zone the reports' printed clock is in
 * @returns One group per report, in report order; fails with a `ParseError`
 *   when a synthesized resource does not satisfy its `fhir-r4` schema
 */
const adoptedResourcesOf = (
  reports: readonly Report.Type[],
  options: SynthesisOptions
): Effect.Effect<readonly ReportResources[], ParseResult.ParseError> =>
  Effect.map(toFhirResources(reports, options), (groups) =>
    groups.map((group) => ({ ...group, resources: group.resources.map(adopt) }))
  )

export { adoptedResourcesOf }
export type { Type as ReportGroup } from './entities/group.ts'
export type { Type as ReportLab } from './entities/lab.ts'
export type { Type as ReportPatient } from './entities/patient.ts'
export type { Type as LifeLabsReport } from './entities/report.ts'
export type { Type as ReportSection } from './entities/section.ts'
export type { Type as ReportRow } from './entities/test-table-row.ts'
export { toFhirResources, type ReportResources, type SynthesisOptions } from './fhir/to-fhir.ts'
export { defaultLifeLabsPdfSettings, type LifeLabsPdfSettings } from './settings.ts'
export { LIFELABS_SYSTEM } from './source-system.ts'
