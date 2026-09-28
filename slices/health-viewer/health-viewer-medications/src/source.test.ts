import { Schema } from 'effect'
import * as fc from 'fast-check'
import { withMandatoryId } from 'fhir-r4/data-types'
import { MedicationRequest } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import {
  type MedicationRequestWithId,
  medicationRequestsToDoseRegimens,
} from 'medication-core/fhir'
import { describe, expect, test } from 'vite-plus/test'

import { MEDICATIONS_GROUP } from './medication-groups.ts'
import { DOSE_BASES } from './medication-series-key.ts'
import { doseRegimensToSeries, medicationRequestsToSeries } from './medication-series.ts'
import { medicationSource } from './source.ts'

const RUNS = numRunsFor({ base: 200 })

const decodeRequest = Schema.decodeUnknownSync(withMandatoryId(MedicationRequest.Schema))

/** A metformin request as the FHIR server returns one, overlaid with `overrides` as wire JSON. */
const metformin = (id: string, overrides: Record<string, unknown>): MedicationRequestWithId =>
  decodeRequest({
    resourceType: 'MedicationRequest',
    id,
    status: 'active',
    intent: 'order',
    subject: { reference: 'Patient/1' },
    authoredOn: '2026-01-01T00:00:00Z',
    medicationCodeableConcept: { text: 'Metformin 500 mg tablet' },
    dosageInstruction: [{ doseAndRate: [{ doseQuantity: { value: 500, unit: 'mg' } }] }],
    ...overrides,
  })

describe('medicationSource', () => {
  test('is the medication reader under the m prefix', () => {
    expect(medicationSource.name).toBe('medications')
    expect(medicationSource.idPrefix).toBe('m')
    expect(medicationSource.read).toBe(medicationRequestsToSeries)
  })

  test('every id it mints starts with its prefix and parses back', () => {
    fc.assert(
      fc.property(
        fc.record({
          medication: fc.string(),
          doseUnit: fc.option(fc.string(), { nil: null }),
          doseBasis: fc.constantFrom(...DOSE_BASES),
        }),
        (key) => {
          const id = medicationSource.seriesIdOf(key)
          expect(id.startsWith(`${medicationSource.idPrefix}:`)).toBe(true)
          expect(medicationSource.parseSeriesId(id)).toEqual(key)
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('declares one Medications group and files every series under it', () => {
    expect(medicationSource.groups).toEqual([{ id: 'medications', label: 'Medications' }])
    const [series] = doseRegimensToSeries(
      medicationRequestsToDoseRegimens([metformin('mr-1', {})]).regimens
    )
    expect(medicationSource.groupIdOf(series)).toBe(MEDICATIONS_GROUP)
  })

  test('read passes the regimen accounting through beside the series', () => {
    const requests = [
      metformin('mr-1', {}),
      metformin('mr-undated', { authoredOn: undefined }),
      metformin('mr-cancelled', { status: 'cancelled' }),
      metformin('mr-no-dose', { dosageInstruction: [] }),
    ]
    const regimenBatch = medicationRequestsToDoseRegimens(requests)
    const reading = medicationSource.read(requests)
    expect(reading).toEqual({
      series: doseRegimensToSeries(regimenBatch.regimens),
      undated: 1,
      dropped: 2,
    })
    expect(reading.series.map((series) => series.id)).toEqual([
      'm:metformin tablet|mg|administration',
    ])
  })
})
