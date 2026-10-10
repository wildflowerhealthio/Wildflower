import { Effect, type ParseResult, Schema } from 'effect'
import {
  DiagnosticReport,
  type FhirResource,
  Observation,
  Patient,
  Practitioner,
} from 'fhir-r4/resources'

import type * as Report from '../entities/report.ts'
import { diagnosticReportWire, reportOriginalId } from './wire/diagnostic-report.ts'
import { observationOriginalId, observationWire } from './wire/observation.ts'
import { patientOriginalId, patientWire } from './wire/patient.ts'
import { practitionerOriginalId, practitionerWire } from './wire/practitioner.ts'
import type { Wire } from './wire/shared.ts'

/** The per-import inputs the synthesis needs beyond the reports themselves. */
interface SynthesisOptions {
  /** The IANA zone the report's printed clock is in (`America/Toronto`). */
  readonly timeZone: string
}

/**
 * One report's synthesized resources, still paired with the report that
 * minted them — the grouping the importer's per-report review sections are
 * built from.
 *
 * @remarks
 * A `Patient` or `Practitioner` several reports share appears once, in the
 * group of the first report that names it (each is deduplicated by id across
 * the whole document), so flattening the groups in order writes every
 * reference target before its referrer.
 */
interface ReportResources {
  readonly report: Report.Type
  readonly resources: readonly FhirResource[]
}

const decodePatient = Schema.decodeUnknown(Patient.Schema)
const decodePractitioner = Schema.decodeUnknown(Practitioner.Schema)
const decodeDiagnosticReport = Schema.decodeUnknown(DiagnosticReport.Schema)
const decodeObservation = Schema.decodeUnknown(Observation.Schema)

/**
 * Synthesize the FHIR resources for a set of parsed LifeLabs reports, grouped
 * per report.
 *
 * @param reports - The reports one positioned-text document parsed to
 * @param options - The time zone the reports' printed clocks are in
 * @returns One {@link ReportResources} per report, in report order: the
 *   `Practitioner`s and `Patient` this report is first to name, then its
 *   `Observation`s and the `DiagnosticReport` that lists them — so the
 *   flattened groups are an order a writer can persist in, a reference never
 *   preceding its target; fails with a `ParseError` when a synthesized
 *   resource does not satisfy its `fhir-r4` schema
 */
const toFhirResources = (
  reports: readonly Report.Type[],
  options: SynthesisOptions
): Effect.Effect<readonly ReportResources[], ParseResult.ParseError> =>
  Effect.gen(function* () {
    const { timeZone } = options
    const seenPatients = new Set<string>()
    const seenPractitioners = new Set<string>()
    const groups: ReportResources[] = []
    for (const report of reports) {
      const resources: FhirResource[] = []
      // Every provider the report names — the ordering provider and each CC'd
      // provider — becomes a `resultsInterpreter` reference on this report's
      // DiagnosticReport. The ids are collected per report (deduped within it),
      // while the Practitioner resources they point at are minted once across
      // the whole document, in the first group that names each.
      const providerNames = [report.orderedBy, ...report.copyTo]
        .map((name) => name.trim())
        .filter((name) => name !== '')
      const interpreterIds: string[] = []
      const seenInReport = new Set<string>()
      for (const name of providerNames) {
        const id = practitionerOriginalId(name)
        if (!seenInReport.has(id)) {
          seenInReport.add(id)
          interpreterIds.push(id)
        }
        if (seenPractitioners.has(id)) continue
        seenPractitioners.add(id)
        resources.push(yield* decodePractitioner(practitionerWire(name)))
      }
      const patientId = patientOriginalId(report.patient)
      if (!seenPatients.has(patientId)) {
        seenPatients.add(patientId)
        resources.push(yield* decodePatient(patientWire(report)))
      }

      const reportId = reportOriginalId(report)
      const observations: Wire[] = []
      const observationIds: string[] = []
      let ordinal = 0
      for (const section of report.sections) {
        for (const group of section.groups) {
          for (const row of group.rows) {
            const id = observationOriginalId(reportId, section.name, group.name, row, ordinal)
            ordinal += 1
            observationIds.push(id)
            observations.push(
              observationWire(report, patientId, section.name, group.name, row, id, timeZone)
            )
          }
        }
      }
      for (const wire of observations) resources.push(yield* decodeObservation(wire))
      resources.push(
        yield* decodeDiagnosticReport(
          diagnosticReportWire(
            report,
            reportId,
            patientId,
            observationIds,
            timeZone,
            interpreterIds
          )
        )
      )
      groups.push({ report, resources })
    }
    return groups
  })

export { patientOriginalId, practitionerOriginalId, reportOriginalId, toFhirResources }
export type { ReportResources, SynthesisOptions }
