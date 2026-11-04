import type * as Report from '../../entities/report.ts'
import { LifeLabsIdentifierSystem } from '../../source-system.ts'
import {
  keyWire,
  performerWire,
  referenceWire,
  reportStatus,
  sourceId,
  timingWire,
  type Wire,
} from './shared.ts'

const REPORT_CATEGORY_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v2-0074'
const LOINC_SYSTEM = 'http://loinc.org'

/** LOINC's code for a laboratory report as a whole. */
const LABORATORY_REPORT_LOINC = { code: '11502-2', display: 'Laboratory report' }

/**
 * A report is keyed by its lab number together with its date of service —
 * the lab number alone is the identity on a genuine report, but an
 * anonymized export masks every lab number to the same digits, and the
 * date keeps those reports apart.
 *
 * @param report - The report to key
 * @param repeat - How many earlier reports in the same document print this
 *   report's lab number and date of service: `0` for the first (whose key is
 *   the lab number and date alone), counting up from there
 *
 * @remarks
 * Each report a document prints starts at its own `Page 1 of N`, so two
 * reports that share a lab number and date of service are still two reports
 * — an export masked down to `0000-XX0000000` and `Xxx 00 0000 00:00`, say —
 * and `repeat` keeps their ids apart rather than merging them. The first keeps
 * the plain key, so a document with no repeats mints the same ids as before.
 */
const reportOriginalId = (report: Report.Type, repeat: number): string =>
  sourceId(
    repeat === 0
      ? ['report', report.labNo, report.dateOfService]
      : ['report', report.labNo, report.dateOfService, String(repeat)]
  )

const diagnosticReportWire = (
  report: Report.Type,
  id: string,
  patientId: string,
  observationIds: readonly string[],
  timeZone: string,
  resultsInterpreterIds: readonly string[]
): Wire => {
  const sections = report.sections.map((section) => section.name).filter((name) => name !== '')
  const wire: Wire = {
    resourceType: 'DiagnosticReport',
    // A report whose pages print no `Lab No` carries its key alone.
    identifier: [
      keyWire(id),
      ...(report.labNo === ''
        ? []
        : [{ system: LifeLabsIdentifierSystem.LabNumber, value: report.labNo }]),
    ],
    status: reportStatus(report),
    category: [
      { coding: [{ system: REPORT_CATEGORY_SYSTEM, code: 'LAB', display: 'Laboratory' }] },
    ],
    code: {
      coding: [{ system: LOINC_SYSTEM, ...LABORATORY_REPORT_LOINC }],
      text: sections.length === 0 ? LABORATORY_REPORT_LOINC.display : sections.join(', '),
    },
    subject: referenceWire('Patient', patientId),
    ...timingWire(report, timeZone),
    result: observationIds.map((observationId) => referenceWire('Observation', observationId)),
  }
  if (resultsInterpreterIds.length > 0) {
    wire['resultsInterpreter'] = resultsInterpreterIds.map((practitionerId) =>
      referenceWire('Practitioner', practitionerId)
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

export { diagnosticReportWire, reportOriginalId }
