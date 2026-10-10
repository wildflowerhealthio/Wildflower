import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import { MedicationRequest, Observation } from '@wildflowerhealthio/fhir-r4/resources'
import { medicationSource } from '@wildflowerhealthio/health-viewer-medications'
import { observationSource } from '@wildflowerhealthio/health-viewer-observations'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import type { MedicationRequestWithId } from '@wildflowerhealthio/medication-core/fhir'
import { Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { CATALOG_GROUPS, SERIES_SOURCES, isKnownSeriesId, readRecord } from './series-sources.ts'

const RUNS = numRunsFor({ base: 200 })

const decodeObservation = Schema.decodeUnknownSync(Observation.Schema)
const decodeMedicationRequest = Schema.decodeUnknownSync(withMandatoryId(MedicationRequest.Schema))

/** A dated glucose reading in `unit`, filed under `category`. */
const glucose = (unit: string, category: string | null): Observation.Type =>
  decodeObservation({
    resourceType: 'Observation',
    status: 'final',
    code: { coding: [{ system: 'http://loinc.org', code: '2339-0' }], text: 'Glucose' },
    ...(category === null ? {} : { category: [{ coding: [{ code: category }] }] }),
    effectiveDateTime: '2024-01-01T00:00:00Z',
    valueQuantity: { value: 5.4, unit },
  })

/** An active metformin request authored on New Year's Day 2024, overlaid with `overrides`. */
const metformin = (id: string, overrides: Record<string, unknown>): MedicationRequestWithId =>
  decodeMedicationRequest({
    resourceType: 'MedicationRequest',
    id,
    status: 'active',
    intent: 'order',
    subject: { reference: 'Patient/1' },
    authoredOn: '2024-01-01T00:00:00Z',
    medicationCodeableConcept: { text: 'Metformin 500 mg tablet' },
    dosageInstruction: [{ doseAndRate: [{ doseQuantity: { value: 500, unit: 'mg' } }] }],
    ...overrides,
  })

const medicationKeyArb = fc.record({
  medication: fc.string(),
  doseUnit: fc.option(fc.string(), { nil: null }),
  doseBasis: fc.constantFrom('administration' as const, 'd' as const),
})

describe('SERIES_SOURCES', () => {
  test('prefixes are distinct, so every id dispatches to one source', () => {
    const prefixes = SERIES_SOURCES.map((source) => source.idPrefix)
    expect(new Set(prefixes).size).toBe(prefixes.length)
  })

  test('group ids are distinct across sources, so no two sources share a heading', () => {
    const groupIds = CATALOG_GROUPS.map((group) => group.id)
    expect(new Set(groupIds).size).toBe(groupIds.length)
  })

  test('the catalogue lists each source’s groups, source by source', () => {
    expect(CATALOG_GROUPS).toEqual(SERIES_SOURCES.flatMap((source) => source.groups))
  })

  test('observations come first and Medications is the last heading', () => {
    expect(SERIES_SOURCES.map((source) => source.name)).toEqual(['observations', 'medications'])
    expect(CATALOG_GROUPS.at(-1)).toEqual({ id: 'medications', label: 'Medications' })
  })
})

describe('isKnownSeriesId', () => {
  test('agrees with whether any source parses the id', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.string().map((body) => `o:${body}`),
          fc.string().map((body) => `m:${body}`)
        ),
        (id) => {
          expect(isKnownSeriesId(id)).toBe(
            SERIES_SOURCES.some((source) => source.parseSeriesId(id) !== null)
          )
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('every id a source mints is known', () => {
    fc.assert(
      fc.property(
        fc.record({
          system: fc.option(fc.string(), { nil: null }),
          code: fc.string(),
          unit: fc.option(fc.string(), { nil: null }),
        }),
        (key) => {
          expect(isKnownSeriesId(observationSource.seriesIdOf(key))).toBe(true)
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('every medication id the medication source mints is known', () => {
    fc.assert(
      fc.property(medicationKeyArb, (key) => {
        expect(isKnownSeriesId(medicationSource.seriesIdOf(key))).toBe(true)
      }),
      { numRuns: RUNS }
    )
  })

  test('an id no source would write is unknown', () => {
    for (const id of ['m:insulin|mg', 'm:insulin|mg|day', 'x:a|b|c', 'o:a|b']) {
      expect(isKnownSeriesId(id)).toBe(false)
    }
  })
})

describe('readRecord', () => {
  test('files each observation series under the group its source names, and keeps the accounting', () => {
    const observations = [
      glucose('mmol/L', 'laboratory'),
      glucose('mg/dL', null),
      decodeObservation({ resourceType: 'Observation', status: 'final', code: { text: 'Note' } }),
    ]
    const expected = observationSource.read(observations)
    const reading = readRecord({ observations, medicationRequests: [] })
    expect(reading.filed).toEqual(
      expected.series.map((series) => ({ groupId: observationSource.groupIdOf(series), series }))
    )
    expect(reading.filed.map((entry) => entry.groupId)).toEqual(['laboratory', 'other'])
    expect({ undated: reading.undated, dropped: reading.dropped }).toEqual({
      undated: expected.undated,
      dropped: expected.dropped,
    })
    expect(reading.dropped).toBe(1)
  })

  test('files medication series under Medications after the observations, summing both sources’ accounting', () => {
    const observations = [
      glucose('mmol/L', 'laboratory'),
      decodeObservation({ resourceType: 'Observation', status: 'final', code: { text: 'Note' } }),
    ]
    const medicationRequests = [
      metformin('mr-1', {}),
      metformin('mr-undated', { authoredOn: undefined }),
      metformin('mr-cancelled', { status: 'cancelled' }),
    ]
    const observationReading = observationSource.read(observations)
    const medicationReading = medicationSource.read(medicationRequests)
    const reading = readRecord({ observations, medicationRequests })
    expect(reading.filed).toEqual([
      ...observationReading.series.map((series) => ({ groupId: 'laboratory', series })),
      ...medicationReading.series.map((series) => ({ groupId: 'medications', series })),
    ])
    expect(reading.filed.map((entry) => entry.series.id)).toEqual([
      'o:http://loinc.org|2339-0|mmol/L',
      'm:metformin tablet|mg|administration',
    ])
    expect({ undated: reading.undated, dropped: reading.dropped }).toEqual({
      undated: observationReading.undated + medicationReading.undated,
      dropped: observationReading.dropped + medicationReading.dropped,
    })
    expect({ undated: reading.undated, dropped: reading.dropped }).toEqual({
      undated: 1,
      dropped: 2,
    })
  })
})
