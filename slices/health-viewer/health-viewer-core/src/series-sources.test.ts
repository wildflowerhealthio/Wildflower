import { Schema } from 'effect'
import * as fc from 'fast-check'
import { Observation } from 'fhir-r4/resources'
import { observationSource } from 'health-viewer-observations'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { CATALOG_GROUPS, SERIES_SOURCES, isKnownSeriesId, readRecord } from './series-sources.ts'

const RUNS = numRunsFor({ base: 200 })

const decodeObservation = Schema.decodeUnknownSync(Observation.Schema)

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
})

describe('isKnownSeriesId', () => {
  test('agrees with whether any source parses the id', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.string().map((body) => `o:${body}`)
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

  test('a medication id is unknown until the medication source is assembled', () => {
    expect(isKnownSeriesId('m:insulin|mg')).toBe(false)
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
    const reading = readRecord({ observations })
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
})
