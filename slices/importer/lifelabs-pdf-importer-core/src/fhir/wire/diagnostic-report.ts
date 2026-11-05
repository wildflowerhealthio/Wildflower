import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'

import type * as Report from '../../entities/report.ts'
import { LifeLabsIdentifierSystem } from '../../source-system.ts'
import { performerWire, reportStatus, timingWire, type Wire } from './shared.ts'

const REPORT_CATEGORY_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v2-0074'
const LOINC_SYSTEM = 'http://loinc.org'

/** LOINC's code for a laboratory report as a whole. */
const LABORATORY_REPORT_LOINC = { code: '11502-2', display: 'Laboratory report' }

/**
 * A report is keyed by the `Lab No` it prints.
 *
 * @remarks
 * Two reports printing one `Lab No` (an anonymized export masks every lab
 * number to the same digits) are one key, and so one stored record.
 */
const reportKeyOf = (report: Report.Type): DetachedResource.Key => ({
  system: LifeLabsIdentifierSystem.LabNumber,
  value: report.labNo,
})

const diagnosticReportWire = (
  report: Report.Type,
  patientKey: DetachedResource.Key,
  observationKeys: readonly DetachedResource.Key[],
  timeZone: string,
  resultsInterpreterKeys: readonly DetachedResource.Key[]
): Wire => {
  const sections = report.sections.map((section) => section.name).filter((name) => name !== '')
  const wire: Wire = {
    resourceType: 'DiagnosticReport',
    identifier: [DetachedResource.keyIdentifierWire(reportKeyOf(report))],
    status: reportStatus(report),
    category: [
      { coding: [{ system: REPORT_CATEGORY_SYSTEM, code: 'LAB', display: 'Laboratory' }] },
    ],
    code: {
      coding: [{ system: LOINC_SYSTEM, ...LABORATORY_REPORT_LOINC }],
      text: sections.length === 0 ? LABORATORY_REPORT_LOINC.display : sections.join(', '),
    },
    subject: DetachedResource.logicalReferenceWire('Patient', patientKey),
    ...timingWire(report, timeZone),
    result: observationKeys.map((key) => DetachedResource.logicalReferenceWire('Observation', key)),
  }
  if (resultsInterpreterKeys.length > 0) {
    wire['resultsInterpreter'] = resultsInterpreterKeys.map((key) =>
      DetachedResource.logicalReferenceWire('Practitioner', key)
    )
  }
  const licences = new Set(
    report.sections.flatMap((section) =>
      section.groups.flatMap((group) => group.rows.map((row) => row.labLicence))
    )
  )
  // Rows above the first printed licence carry none; their address-only
  // performer is the same lab the licensed entries already name, so it is
  // listed only when no row prints a licence at all.
  const printed = [...licences].filter((licence) => licence !== '')
  const performer = (printed.length > 0 ? printed : ['']).flatMap((licence) =>
    performerWire(report, licence)
  )
  if (performer.length > 0) wire['performer'] = performer
  const sectionComments = report.sections.flatMap((section) => section.comments)
  if (sectionComments.length > 0) wire['conclusion'] = sectionComments.join('\n')
  return wire
}

export { diagnosticReportWire, reportKeyOf }
