import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import {
  DiagnosticReport,
  Observation,
  Patient,
  Practitioner,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Effect, type ParseResult } from 'effect'

import type * as Report from '../entities/report.ts'
import { diagnosticReportWire, reportKeyOf } from './wire/diagnostic-report.ts'
import { observationKeyOf, observationWire } from './wire/observation.ts'
import { patientKeyOf, patientWire } from './wire/patient.ts'
import { practitionerKeyOf, practitionerWire } from './wire/practitioner.ts'
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
 * group of the first report that names it (each is deduplicated by key across
 * the whole document), so flattening the groups in order writes every
 * reference target before its referrer.
 */
interface ReportResources {
  readonly report: Report.Type
  readonly resources: readonly DetachedResource.Type[]
}

const decodePatient = DetachedResource.decodeUnknown(Patient.Schema)
const decodePractitioner = DetachedResource.decodeUnknown(Practitioner.Schema)
const decodeDiagnosticReport = DetachedResource.decodeUnknown(DiagnosticReport.Schema)
const decodeObservation = DetachedResource.decodeUnknown(Observation.Schema)

/** A key as one string, for telling keys apart: its system and value. */
const keyText = ({ system, value }: DetachedResource.Key): string => `${system}|${value}`

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
 *
 * @remarks
 * Every report is its own `DiagnosticReport`, keyed by the `Lab No` it
 * prints. Two reports printing one `Lab No` share that key, and their rows
 * at the same ordinal under the same section and test name share theirs, so
 * the import stores each such pair as one record.
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
      const resources: DetachedResource.Type[] = []
      // Every provider the report names — the ordering provider and each CC'd
      // provider — becomes a `resultsInterpreter` reference on this report's
      // DiagnosticReport. The keys are collected per report (deduped within
      // it), while the Practitioner resources they name are minted once
      // across the whole document, in the first group that names each.
      const providerNames = [report.orderedBy, ...report.copyTo]
        .map((name) => name.trim())
        .filter((name) => name !== '')
      const interpreterKeys: DetachedResource.Key[] = []
      const seenInReport = new Set<string>()
      for (const name of providerNames) {
        const key = practitionerKeyOf(name)
        if (!seenInReport.has(keyText(key))) {
          seenInReport.add(keyText(key))
          interpreterKeys.push(key)
        }
        if (seenPractitioners.has(keyText(key))) continue
        seenPractitioners.add(keyText(key))
        resources.push(yield* decodePractitioner(practitionerWire(name)))
      }
      const patientKey = patientKeyOf(report.patient)
      if (!seenPatients.has(keyText(patientKey))) {
        seenPatients.add(keyText(patientKey))
        resources.push(yield* decodePatient(patientWire(report)))
      }

      const observations: Wire[] = []
      const observationKeys: DetachedResource.Key[] = []
      let ordinal = 0
      for (const section of report.sections) {
        for (const group of section.groups) {
          for (const row of group.rows) {
            const key = observationKeyOf(report, section.name, row, ordinal)
            ordinal += 1
            observationKeys.push(key)
            observations.push(
              observationWire({
                report,
                row,
                section: section.name,
                group: group.name,
                key,
                patientKey,
                timeZone,
              })
            )
          }
        }
      }
      for (const wire of observations) resources.push(yield* decodeObservation(wire))
      resources.push(
        yield* decodeDiagnosticReport(
          diagnosticReportWire(report, patientKey, observationKeys, timeZone, interpreterKeys)
        )
      )
      groups.push({ report, resources })
    }
    return groups
  })

export { observationKeyOf, patientKeyOf, practitionerKeyOf, reportKeyOf, toFhirResources }
export type { ReportResources, SynthesisOptions }
