import type { HealthCardProvince } from '@wildflowerhealthio/fhir-ca-infoway'
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { DiagnosticReport, Observation, Patient } from '@wildflowerhealthio/fhir-r4/resources'
import type { FileSetRecord } from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, DateTime, Effect, Option, Order, type ParseResult } from 'effect'

import type * as Report from '../entities/report.ts'
import { parsePrintedDateTime } from './dates.ts'
import { diagnosticReportWire, reportKeyOf } from './wire/diagnostic-report.ts'
import { observationKeyOf, observationWire } from './wire/observation.ts'
import { patientKeyOf, patientWire } from './wire/patient.ts'
import type { Wire } from './wire/shared.ts'

/** The per-import inputs the synthesis needs beyond the reports themselves. */
interface SynthesisOptions {
  /** The IANA zone the report's printed clock is in (`America/Toronto`). */
  readonly timeZone: string
  /** The province that issued the health card the report prints as `HC #`. */
  readonly healthCardProvince: HealthCardProvince.Type
}

/**
 * One report's synthesized resources, still paired with the report that
 * minted them — the grouping the importer's per-report review sections are
 * built from.
 *
 * @remarks
 * Each resource is a record whose local key is its type and its key's value,
 * `<Type>/<value>`, which a settings re-decode keeps. A `Patient` several
 * reports share appears once, in the group of the first report that names it
 * (deduplicated by key across the whole document). A provider is no record:
 * each report names its providers by printed name, and the import stage
 * implies their Practitioners.
 */
interface ReportResources {
  readonly report: Report.Type
  readonly records: readonly FileSetRecord.Type[]
}

const decodePatient = DetachedResource.decodeUnknown(Patient.Schema)
const decodeDiagnosticReport = DetachedResource.decodeUnknown(DiagnosticReport.Schema)
const decodeObservation = DetachedResource.decodeUnknown(Observation.Schema)

/** A key as one string, for telling keys apart: its system and value. */
const keyText = ({ system, value }: DetachedResource.Key): string => `${system}|${value}`

/** `resource`, minted keyed by `key`, as its record: local key `<Type>/<key value>`. */
const recordOf = (
  key: DetachedResource.Key,
  resource: DetachedResource.Type
): FileSetRecord.Type => ({
  localKey: `${resource.resourceType}/${key.value}`,
  resource,
})

/**
 * Each Patient's latest report, by its key: the one whose patient block the
 * Patient is written from, so a card reissued between reports carries its
 * current version code. Reports are ordered by when they were reported, one
 * printing no readable time first, and of two reported at once the earlier in
 * the document wins.
 */
const latestReportByPatientKey = (
  reportsWithPatientKeys: readonly (readonly [Report.Type, DetachedResource.Key])[],
  timeZone: string
): Readonly<Record<string, Report.Type>> => {
  const byReportedOn = Order.mapInput(
    Option.getOrder(DateTime.Order),
    ([report]: readonly [Report.Type, DetachedResource.Key]): Option.Option<DateTime.Utc> =>
      parsePrintedDateTime(report.reportedOn, timeZone)
  )
  const naming = Arr.groupBy(reportsWithPatientKeys, ([, patientKey]) => keyText(patientKey))
  return Object.fromEntries(
    Object.entries(naming).map(([key, group]) => [key, Arr.max(group, byReportedOn)[0]])
  )
}

/**
 * Synthesize the FHIR resources for a set of parsed LifeLabs reports, grouped
 * per report.
 *
 * @param reports - The reports one positioned-text document parsed to
 * @param options - The time zone the reports' printed clocks are in, and the
 *   province that issued the health card they print
 * @returns One {@link ReportResources} per report, in report order: the
 *   `Patient` when this report is first to name it (the `Patient` written
 *   from the latest report naming it), then its `Observation`s and the
 *   `DiagnosticReport` that lists them; fails with a `ParseError` when a
 *   report's `HC #` is not the chosen province's shape, or a synthesized
 *   resource does not satisfy its `fhir-r4` schema
 *
 * @remarks
 * Every report is its own `DiagnosticReport`, keyed by the `Lab No` it
 * prints, and each of its rows an `Observation` keyed under that `Lab No`.
 * The reports handed in print distinct `Lab No`s — the parse reads one report
 * per `Lab No` — so every record has its own key, and so its own local key.
 */
const toFhirResources = (
  reports: readonly Report.Type[],
  options: SynthesisOptions
): Effect.Effect<readonly ReportResources[], ParseResult.ParseError> =>
  Effect.gen(function* () {
    const { timeZone, healthCardProvince } = options
    const patientKeys = yield* Effect.forEach(reports, (report) =>
      patientKeyOf(report.patient, healthCardProvince)
    )
    const reportsWithPatientKeys = Arr.zip(reports, patientKeys)
    const latestReportNaming = latestReportByPatientKey(reportsWithPatientKeys, timeZone)
    const seenPatients = new Set<string>()
    const groups: ReportResources[] = []
    for (const [report, patientKey] of reportsWithPatientKeys) {
      const records: FileSetRecord.Type[] = []
      if (!seenPatients.has(keyText(patientKey))) {
        seenPatients.add(keyText(patientKey))
        const latest = latestReportNaming[keyText(patientKey)] ?? report
        records.push(
          recordOf(patientKey, yield* decodePatient(yield* patientWire(latest, healthCardProvince)))
        )
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
      for (const [key, wire] of Arr.zip(observationKeys, observations)) {
        records.push(recordOf(key, yield* decodeObservation(wire)))
      }
      records.push(
        recordOf(
          reportKeyOf(report),
          yield* decodeDiagnosticReport(
            diagnosticReportWire(report, patientKey, observationKeys, timeZone)
          )
        )
      )
      groups.push({ report, records })
    }
    return groups
  })

export { observationKeyOf, patientKeyOf, reportKeyOf, toFhirResources }
export type { ReportResources, SynthesisOptions }
