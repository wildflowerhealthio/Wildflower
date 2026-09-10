import { DateTime, Effect, Option, type ParseResult, Schema } from 'effect'
import { joinIdComponents } from 'fhir-r4/identity'
import {
  DiagnosticReport,
  type FhirResource,
  Observation,
  Patient,
  Practitioner,
} from 'fhir-r4/resources'
import { fnv1a64 } from 'kitchen-sink'

import type * as Report from '../entities/report.ts'
import type * as TestTableRow from '../entities/test-table-row.ts'
import { LifeLabsIdentifierSystem } from '../source-system.ts'
import { parsePrintedDate, parsePrintedDateTime } from './dates.ts'
import { parseReferenceRange } from './reference-range.ts'
import { parseResultValue } from './result-value.ts'

/** The per-import inputs the synthesis needs beyond the reports themselves. */
interface SynthesisOptions {
  /** The IANA zone the report's printed clock is in (`America/Toronto`). */
  readonly timeZone: string
}

const OBSERVATION_CATEGORY_SYSTEM = 'http://terminology.hl7.org/CodeSystem/observation-category'
const REPORT_CATEGORY_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v2-0074'
const INTERPRETATION_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation'
const LOINC_SYSTEM = 'http://loinc.org'

/** LOINC's code for a laboratory report as a whole. */
const LABORATORY_REPORT_LOINC = { code: '11502-2', display: 'Laboratory report' }

const decodePatient = Schema.decodeUnknown(Patient.Schema)
const decodePractitioner = Schema.decodeUnknown(Practitioner.Schema)
const decodeDiagnosticReport = Schema.decodeUnknown(DiagnosticReport.Schema)
const decodeObservation = Schema.decodeUnknown(Observation.Schema)

type Wire = Record<string, unknown>

/** The interpretation codings the report's flags map to. */
const INTERPRETATIONS: Readonly<
  Record<string, { readonly code: string; readonly display: string }>
> = {
  HI: { code: 'H', display: 'High' },
  LO: { code: 'L', display: 'Low' },
}

const digitsOf = (text: string): string => text.replaceAll(/\D/g, '')

/**
 * The source id for a resource, from the report facts that determine it: the
 * components folded the way `fhir-r4/identity` folds them (length-prefixed,
 * so no component can impersonate two) and digested to sixteen hex digits.
 *
 * @remarks
 * A digest rather than the joined text because a source id has to be a FHIR
 * `id` — `[A-Za-z0-9\-.]`, at most 64 characters — for the adoption's
 * reference rewrite to recognize `Observation/<id>`; a practitioner's printed
 * name or a joined lab-number-and-date is neither. The facts themselves stay
 * readable on the resource (identifiers, `name.text`), only the key is hashed.
 */
const sourceId = (components: readonly string[]): string =>
  fnv1a64(joinIdComponents(components)).toString(16).padStart(16, '0')

/**
 * The id the report determines for its patient: the printed `Patient ID`,
 * else the health card number's digits, else the name and date of birth
 * together — the most stable fact the report prints, in that order.
 */
const patientOriginalId = (patient: Report.Type['patient']): string => {
  if (patient.patientId !== '') return sourceId(['patient-id', patient.patientId])
  const healthCard = digitsOf(patient.healthCardNumber)
  if (healthCard !== '') return sourceId(['health-card', healthCard])
  return sourceId(['name', patient.name, patient.dateOfBirth])
}

/** A practitioner is keyed by the name the report prints for them. */
const practitionerOriginalId = (name: string): string => sourceId(['practitioner', name.trim()])

/**
 * A report is keyed by its lab number together with its date of service —
 * the lab number alone is the identity on a genuine report, but an
 * anonymized export masks every lab number to the same digits, and the
 * date keeps those reports apart.
 */
const reportOriginalId = (report: Report.Type): string =>
  sourceId(['report', report.labNo, report.dateOfService])

const observationOriginalId = (
  reportId: string,
  section: string,
  group: string,
  row: TestTableRow.Type,
  ordinal: number
): string => sourceId(['observation', reportId, section, group, row.name, String(ordinal)])

/** `FAMILY, GIVEN GIVEN` → a HumanName; any other shape becomes `text`. */
const humanNameWire = (printed: string): Wire => {
  const [family, given] = printed.split(',', 2).map((part) => part.trim())
  if (family !== undefined && given !== undefined && family.length > 0) {
    return { family, given: given.split(/\s+/).filter((part) => part.length > 0), text: printed }
  }
  return { text: printed }
}

const genderOf = (sex: string): string | undefined => {
  switch (sex.trim().toUpperCase()) {
    case 'F':
      return 'female'
    case 'M':
      return 'male'
    default:
      return undefined
  }
}

const patientWire = (report: Report.Type, generalPractitionerId: string | undefined): Wire => {
  const { patient } = report
  const identifier: Wire[] = []
  if (patient.patientId !== '') {
    identifier.push({ system: LifeLabsIdentifierSystem.PatientId, value: patient.patientId })
  }
  if (patient.healthCardNumber !== '') {
    identifier.push({
      system: LifeLabsIdentifierSystem.OntarioHealthCardNumber,
      value: patient.healthCardNumber,
    })
  }
  const wire: Wire = { resourceType: 'Patient', id: patientOriginalId(patient) }
  if (identifier.length > 0) wire['identifier'] = identifier
  if (patient.name !== '') wire['name'] = [humanNameWire(patient.name)]
  const gender = genderOf(patient.sex)
  if (gender !== undefined) wire['gender'] = gender
  const birthDate = parsePrintedDate(patient.dateOfBirth)
  if (Option.isSome(birthDate)) wire['birthDate'] = birthDate.value
  if (patient.phone !== '') wire['telecom'] = [{ system: 'phone', value: patient.phone }]
  if (generalPractitionerId !== undefined) {
    wire['generalPractitioner'] = [{ reference: `Practitioner/${generalPractitionerId}` }]
  }
  return wire
}

const practitionerWire = (name: string): Wire => ({
  resourceType: 'Practitioner',
  id: practitionerOriginalId(name),
  name: [{ text: name.trim() }],
})

/** The laboratory as a display-only performer: its licence and address. */
const performerWire = (report: Report.Type, licence: string): Wire[] => {
  const display = [licence === '' ? '' : `Lab Lic. ${licence}`, report.lab.addressLines.join(', ')]
    .filter((part) => part.length > 0)
    .join(' · ')
  return display === '' ? [] : [{ display }]
}

const quantityWire = (value: number, unit: string): Wire => {
  const wire: Wire = { value }
  if (unit !== '') wire['unit'] = unit
  return wire
}

const referenceRangeWire = (row: TestTableRow.Type): Wire[] => {
  if (row.referenceRange === '') return []
  const range = parseReferenceRange(row.referenceRange)
  const wire: Wire = { text: range.text }
  if (range.low !== undefined) wire['low'] = quantityWire(range.low, row.unit)
  if (range.high !== undefined) wire['high'] = quantityWire(range.high, row.unit)
  return [wire]
}

const interpretationWire = (flag: string): Wire[] => {
  if (flag === '') return []
  const known = INTERPRETATIONS[flag]
  if (known === undefined) return [{ text: flag }]
  return [{ coding: [{ system: INTERPRETATION_SYSTEM, ...known }], text: flag }]
}

const valueWire = (row: TestTableRow.Type): Wire => {
  if (row.result === '') return {}
  const value = parseResultValue(row.result)
  if (value._tag === 'text') return { valueString: value.text }
  const quantity = quantityWire(value.value, row.unit)
  if (value.comparator !== undefined) quantity['comparator'] = value.comparator
  return { valueQuantity: quantity }
}

const timingWire = (
  report: Report.Type,
  timeZone: string
): { readonly effectiveDateTime?: string; readonly issued?: string } => {
  const wire: { effectiveDateTime?: string; issued?: string } = {}
  const effective = parsePrintedDateTime(report.dateOfService, timeZone)
  if (Option.isSome(effective)) wire.effectiveDateTime = DateTime.formatIso(effective.value)
  const issued = parsePrintedDateTime(report.reportedOn, timeZone)
  if (Option.isSome(issued)) wire.issued = DateTime.formatIso(issued.value)
  return wire
}

const reportStatus = (report: Report.Type): string =>
  report.status.toUpperCase().startsWith('FINAL') ? 'final' : 'unknown'

const observationWire = (
  report: Report.Type,
  patientId: string,
  section: string,
  group: string,
  row: TestTableRow.Type,
  id: string,
  timeZone: string
): Wire => {
  const wire: Wire = {
    resourceType: 'Observation',
    id,
    status: reportStatus(report),
    category: [
      {
        coding: [
          { system: OBSERVATION_CATEGORY_SYSTEM, code: 'laboratory', display: 'Laboratory' },
        ],
        text: [section, group].filter((part) => part.length > 0).join(' · '),
      },
    ],
    code: { text: row.name },
    subject: { reference: `Patient/${patientId}` },
    ...timingWire(report, timeZone),
    ...valueWire(row),
  }
  const performer = performerWire(report, row.labLicence)
  if (performer.length > 0) wire['performer'] = performer
  const interpretation = interpretationWire(row.flag)
  if (interpretation.length > 0) wire['interpretation'] = interpretation
  const referenceRange = referenceRangeWire(row)
  if (referenceRange.length > 0) wire['referenceRange'] = referenceRange
  if (row.comments.length > 0) wire['note'] = [{ text: row.comments.join('\n') }]
  return wire
}

const diagnosticReportWire = (
  report: Report.Type,
  id: string,
  patientId: string,
  observationIds: readonly string[],
  timeZone: string
): Wire => {
  const sections = report.sections.map((section) => section.name).filter((name) => name !== '')
  const wire: Wire = {
    resourceType: 'DiagnosticReport',
    id,
    identifier: [{ system: LifeLabsIdentifierSystem.LabNumber, value: report.labNo }],
    status: reportStatus(report),
    category: [
      { coding: [{ system: REPORT_CATEGORY_SYSTEM, code: 'LAB', display: 'Laboratory' }] },
    ],
    code: {
      coding: [{ system: LOINC_SYSTEM, ...LABORATORY_REPORT_LOINC }],
      text: sections.length === 0 ? LABORATORY_REPORT_LOINC.display : sections.join(', '),
    },
    subject: { reference: `Patient/${patientId}` },
    ...timingWire(report, timeZone),
    result: observationIds.map((observationId) => ({ reference: `Observation/${observationId}` })),
  }
  const licences = new Set(
    report.sections.flatMap((section) =>
      section.groups.flatMap((group) => group.rows.map((row) => row.labLicence))
    )
  )
  const performer = [...licences].flatMap((licence) => performerWire(report, licence))
  if (performer.length > 0) wire['performer'] = performer
  const sectionComments = report.sections.flatMap((section) => section.comments)
  if (sectionComments.length > 0) wire['conclusion'] = sectionComments.join('\n')
  return wire
}

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
