import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { joinIdComponents } from '@wildflowerhealthio/fhir-r4/identity'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { fnv1a64 } from '@wildflowerhealthio/kitchen-sink'
import { DateTime, Option } from 'effect'

import type * as Report from '../../entities/report.ts'
import { LIFELABS_SYSTEM } from '../../source-system.ts'
import { parsePrintedDateTime } from '../dates.ts'
import { ucumCodeFor, UCUM_SYSTEM } from '../units.ts'

type Wire = Record<string, unknown>

/**
 * The source id for a resource, from the report facts that determine it: the
 * components folded the way `fhir-r4/identity` folds them (length-prefixed,
 * so no component can impersonate two) and digested to sixteen hex digits.
 *
 * @remarks
 * A digest rather than the joined text so every key value has one short,
 * fixed shape: a practitioner's printed name or a joined lab-number-and-date
 * would not. The facts themselves stay readable on the resource (identifiers,
 * `name.text`), only the key is hashed. **Persisted wire format:** the value
 * of every LifeLabs record's key, and so part of the id it is stored under.
 */
const sourceId = (components: readonly string[]): string =>
  fnv1a64(joinIdComponents(components)).toString(16).padStart(16, '0')

/** The key identifier wire of the record the synthesis gave `id`: `identifier[0]`. */
const keyWire = (id: string): Wire => ({
  ...DetachedResource.keyIdentifierWire({ system: LIFELABS_SYSTEM, value: id }),
})

/** The logical reference wire to the record of `resourceType` the synthesis gave `id`. */
const referenceWire = (resourceType: FhirResource['resourceType'], id: string): Wire => ({
  ...DetachedResource.logicalReferenceWire(resourceType, { system: LIFELABS_SYSTEM, value: id }),
})

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

export { keyWire, performerWire, quantityWire, referenceWire, reportStatus, sourceId, timingWire }
export type { Wire }
