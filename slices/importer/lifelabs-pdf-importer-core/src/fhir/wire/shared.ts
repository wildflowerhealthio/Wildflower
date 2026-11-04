import { DateTime, Option } from 'effect'

import type * as Report from '../../entities/report.ts'
import { parsePrintedDateTime } from '../dates.ts'
import { ucumCodeFor, UCUM_SYSTEM } from '../units.ts'

type Wire = Record<string, unknown>

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

/**
 * A `Quantity` wire fragment: always the numeric `value`, the printed `unit`
 * spelling when present, and — when that spelling maps to a UCUM code — the
 * matching `system` / `code` beside it, so a reader that computes on units
 * has a machine-checkable code without losing the display the report printed.
 * An unmapped spelling stays as `unit` alone rather than guessing a code.
 */
const quantityWire = (value: number, unit: string): Wire => {
  const wire: Wire = { value }
  if (unit === '') return wire
  wire['unit'] = unit
  const code = ucumCodeFor(unit)
  if (code !== undefined) {
    wire['system'] = UCUM_SYSTEM
    wire['code'] = code
  }
  return wire
}

export { performerWire, quantityWire, reportStatus, timingWire }
export type { Wire }
