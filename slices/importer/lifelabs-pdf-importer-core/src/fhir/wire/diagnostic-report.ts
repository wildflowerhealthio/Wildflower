import type * as Report from '../../entities/report.ts'
import { LifeLabsIdentifierSystem } from '../../source-system.ts'
import { performerWire, reportStatus, sourceId, timingWire, type Wire } from './shared.ts'

const REPORT_CATEGORY_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v2-0074'
const LOINC_SYSTEM = 'http://loinc.org'

/** LOINC's code for a laboratory report as a whole. */
const LABORATORY_REPORT_LOINC = { code: '11502-2', display: 'Laboratory report' }

/**
 * A report is keyed by its lab number together with its date of service —
 * the lab number alone is the identity on a genuine report, but an
 * anonymized export masks every lab number to the same digits, and the
 * date keeps those reports apart.
 */
const reportOriginalId = (report: Report.Type): string =>
  sourceId(['report', report.labNo, report.dateOfService])

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

export { diagnosticReportWire, reportOriginalId }
