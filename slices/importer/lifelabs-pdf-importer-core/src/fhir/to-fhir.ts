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

const decodePatient = Schema.decodeUnknown(Patient.Schema)
const decodePractitioner = Schema.decodeUnknown(Practitioner.Schema)
const decodeDiagnosticReport = Schema.decodeUnknown(DiagnosticReport.Schema)
const decodeObservation = Schema.decodeUnknown(Observation.Schema)

/**
 * Synthesize the FHIR resources for a set of parsed LifeLabs reports.
 *
 * @param reports - The reports one positioned-text document parsed to
 * @param options - The time zone the reports' printed clocks are in
 * @returns Every `Patient` and `Practitioner` the reports name (each once,
 *   by id), then per report its `Observation`s and the `DiagnosticReport`
 *   that lists them — the order a writer can persist in so a reference
 *   never precedes its target; fails with a `ParseError` when a synthesized
 *   resource does not satisfy its `fhir-r4` schema
 */
const toFhirResources = (
  reports: readonly Report.Type[],
  options: SynthesisOptions
): Effect.Effect<readonly FhirResource[], ParseResult.ParseError> =>
  Effect.gen(function* () {
    const { timeZone } = options
    const patients = new Map<string, Wire>()
    const practitioners = new Map<string, Wire>()
    const perReport: Wire[] = []
    for (const report of reports) {
      const orderedBy = report.orderedBy.trim()
      const orderedById = orderedBy === '' ? undefined : practitionerOriginalId(orderedBy)
      for (const name of [orderedBy, ...report.copyTo].map((n) => n.trim())) {
        if (name === '') continue
        const id = practitionerOriginalId(name)
        if (!practitioners.has(id)) practitioners.set(id, practitionerWire(name))
      }
      const patientId = patientOriginalId(report.patient)
      if (!patients.has(patientId)) patients.set(patientId, patientWire(report, orderedById))

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
      perReport.push(
        ...observations,
        diagnosticReportWire(report, reportId, patientId, observationIds, timeZone)
      )
    }

    const resources: FhirResource[] = []
    for (const wire of practitioners.values()) resources.push(yield* decodePractitioner(wire))
    for (const wire of patients.values()) resources.push(yield* decodePatient(wire))
    for (const wire of perReport) {
      resources.push(
        yield* wire['resourceType'] === 'DiagnosticReport'
          ? decodeDiagnosticReport(wire)
          : decodeObservation(wire)
      )
    }
    return resources
  })

export { patientOriginalId, practitionerOriginalId, reportOriginalId, toFhirResources }
export type { SynthesisOptions }
