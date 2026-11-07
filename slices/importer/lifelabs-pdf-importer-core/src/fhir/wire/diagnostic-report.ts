import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Practitioner } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, pipe } from 'effect'

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
 * Every page printing one `Lab No` is a page of one report. An anonymized
 * export masks every lab number to the same digits, so its reports read as
 * one.
 */
const reportKeyOf = (report: Report.Type): DetachedResource.Key => ({
  system: LifeLabsIdentifierSystem.LabNumber,
  value: report.labNo,
})

/**
 * The `resultsInterpreter` wire of `report`: every provider it names, the
 * ordering provider and each CC'd one, once per name, as a logical reference
 * by the printed name in `LifeLabsIdentifierSystem.PractitionerName`
 * (`fhir-r4`'s `Practitioner.tryReferenceWireFromName`), the name as keyed
 * for its display.
 *
 * @remarks
 * The report never numbers a provider, so the name is the key. The import
 * stage implies one Practitioner per name across the whole document, named by
 * this display.
 */
const resultsInterpreterWire = (
  report: Report.Type
): readonly (typeof IdentifierAndReference.ReferenceSchema.Encoded)[] =>
  pipe(
    [report.orderedBy, ...report.copyTo],
    Arr.filterMap((name) =>
      Practitioner.tryReferenceWireFromName(LifeLabsIdentifierSystem.PractitionerName, name)
    ),
    Arr.dedupeWith((left, right) => left.identifier?.value === right.identifier?.value)
  )

const diagnosticReportWire = (
  report: Report.Type,
  patientKey: DetachedResource.Key,
  observationKeys: readonly DetachedResource.Key[],
  timeZone: string
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
  const resultsInterpreter = resultsInterpreterWire(report)
  if (resultsInterpreter.length > 0) wire['resultsInterpreter'] = resultsInterpreter
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
