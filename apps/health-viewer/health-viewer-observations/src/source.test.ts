import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { CATEGORY_ORDER, OTHER_GROUP } from './observation-groups.ts'
import type { ObservationSeries } from './observation-series.ts'
import { observationsToSeries } from './observation-series.ts'
import { observationSource } from './source.ts'

const RUNS = numRunsFor({ base: 200 })

const categoryArb = fc.option(
  fc.oneof(fc.constantFrom(...CATEGORY_ORDER), fc.constantFrom('unheard-of', 'vitals')),
  { nil: null }
)

const seriesIn = (category: string | null): ObservationSeries => ({
  kind: 'points',
  id: 'o:\\~|code|u',
  key: { system: null, code: 'code', unit: 'u' },
  label: 'Code',
  unit: 'u',
  category,
  valueScale: 'fitted',
  interpolation: 'linear',
  points: [{ time: DateTime.unsafeMake(0), value: 1 }],
})

describe('observationSource', () => {
  test('is the observation reader under the o prefix', () => {
    expect(observationSource.name).toBe('observations')
    expect(observationSource.idPrefix).toBe('o')
    expect(observationSource.read).toBe(observationsToSeries)
  })

  test('every id it mints starts with its prefix and parses back', () => {
    fc.assert(
      fc.property(
        fc.record({
          system: fc.option(fc.string(), { nil: null }),
          code: fc.string(),
          unit: fc.option(fc.string(), { nil: null }),
        }),
        (key) => {
          const id = observationSource.seriesIdOf(key)
          expect(id.startsWith(`${observationSource.idPrefix}:`)).toBe(true)
          expect(observationSource.parseSeriesId(id)).toEqual(key)
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('groups are the categories in panel order, then other', () => {
    expect(observationSource.groups.map((group) => group.id)).toEqual([
      ...CATEGORY_ORDER,
      OTHER_GROUP,
    ])
    for (const group of observationSource.groups) expect(group.label.length).toBeGreaterThan(0)
  })

  test('every series files under one of its declared groups', () => {
    fc.assert(
      fc.property(categoryArb, (category) => {
        const groupIds = observationSource.groups.map((group) => group.id)
        expect(groupIds).toContain(observationSource.groupIdOf(seriesIn(category)))
      }),
      { numRuns: RUNS }
    )
  })

  test('a listed category files under itself; an unknown or absent one under other', () => {
    fc.assert(
      fc.property(categoryArb, (category) => {
        const expected =
          category !== null && CATEGORY_ORDER.includes(category) ? category : OTHER_GROUP
        expect(observationSource.groupIdOf(seriesIn(category))).toBe(expected)
      }),
      { numRuns: RUNS }
    )
  })
})
