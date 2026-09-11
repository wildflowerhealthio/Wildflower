import { DateTime, Option } from 'effect'
import { joinIdComponents } from 'fhir-r4/identity'
import { fnv1a64 } from 'kitchen-sink'

import type * as Report from '../../entities/report.ts'
import { parsePrintedDateTime } from '../dates.ts'

type Wire = Record<string, unknown>

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

export { performerWire, quantityWire, reportStatus, sourceId, timingWire }
export type { Wire }
