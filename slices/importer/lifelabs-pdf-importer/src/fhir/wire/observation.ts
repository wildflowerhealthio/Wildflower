import type * as Report from '../../entities/report.ts'
import type * as TestTableRow from '../../entities/test-table-row.ts'
import { parseReferenceRange } from '../reference-range.ts'
import { parseResultValue } from '../result-value.ts'
import {
  performerWire,
  quantityWire,
  reportStatus,
  sourceId,
  timingWire,
  type Wire,
} from './shared.ts'

const OBSERVATION_CATEGORY_SYSTEM = 'http://terminology.hl7.org/CodeSystem/observation-category'
const INTERPRETATION_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation'

/** The interpretation codings the report's flags map to. */
const INTERPRETATIONS: Readonly<
  Record<string, { readonly code: string; readonly display: string }>
> = {
  HI: { code: 'H', display: 'High' },
  LO: { code: 'L', display: 'Low' },
}

const observationOriginalId = (
  reportId: string,
  section: string,
  group: string,
  row: TestTableRow.Type,
  ordinal: number
): string => sourceId(['observation', reportId, section, group, row.name, String(ordinal)])

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

export { observationOriginalId, observationWire }
