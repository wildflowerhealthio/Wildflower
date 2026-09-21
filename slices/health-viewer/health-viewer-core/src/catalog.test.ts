import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import {
  CATEGORY_ORDER,
  type CatalogRow,
  MEDICATIONS_GROUP,
  OTHER_GROUP,
  groupForPanel,
  matchesSearch,
} from './catalog.ts'
import type { MedicationSeries, ObservationSeries, Series } from './series.ts'

const RUNS = numRunsFor({ base: 200 })

const instant = fc.integer({ min: 0, max: 4e12 }).map((millis) => DateTime.unsafeMake(millis))

const observationSeries = (
  code: string,
  category: string | null,
  times: readonly DateTime.Utc[]
): ObservationSeries => ({
  key: { kind: 'observation', system: null, code, unit: 'u' },
  label: code,
  unit: 'u',
  category,
  points: times
    .toSorted((left, right) => left.epochMillis - right.epochMillis)
    .map((time) => ({ time, value: 1 })),
  kind: 'quantity',
})

const medicationSeries = (name: string): MedicationSeries => ({
  key: { kind: 'medication', name, unit: 'mg' },
  label: name,
  unit: 'mg',
  segments: [
    {
      start: DateTime.unsafeMake(0),
      end: DateTime.unsafeMake(86_400_000),
      dose: 5,
      perDay: true,
      status: 'active',
      dashed: false,
      requestId: 'req',
    },
  ],
})

const categoryArb = fc.option(
  fc.oneof(fc.constantFrom(...CATEGORY_ORDER), fc.constantFrom('unheard-of', 'vitals')),
  { nil: null }
)

const seriesArb: fc.Arbitrary<Series> = fc.oneof(
  fc
    .record({
      code: fc.stringMatching(/^[a-z]{1,6}$/),
      category: categoryArb,
      times: fc.array(instant, { maxLength: 5 }),
    })
    .map(({ code, category, times }) => observationSeries(code, category, times)),
  fc.stringMatching(/^[a-z]{1,6}$/).map(medicationSeries)
)

/** Unique by series id, since two identical keys would collapse in a real catalogue. */
const uniqueSeries = fc.uniqueArray(seriesArb, {
  maxLength: 10,
  selector: (series) =>
    series.key.kind === 'observation' ? `o:${series.key.code}` : `m:${series.key.name}`,
})

describe('groupForPanel', () => {
  test('every series lands in exactly one group, none invented, none lost', () => {
    fc.assert(
      fc.property(uniqueSeries, (series) => {
        const rows = groupForPanel(series).flatMap((group) => group.rows)
        expect(rows).toHaveLength(series.length)
        expect(rows.map((row) => row.label).toSorted()).toEqual(
          series.map((entry) => entry.label).toSorted()
        )
      }),
      { numRuns: RUNS }
    )
  })

  test('groups follow the declared order, with other then medications last', () => {
    fc.assert(
      fc.property(uniqueSeries, (series) => {
        const expected = [...CATEGORY_ORDER, OTHER_GROUP, MEDICATIONS_GROUP]
        const ids = groupForPanel(series).map((group) => group.id)
        expect(ids).toEqual(expected.filter((id) => ids.includes(id)))
      }),
      { numRuns: RUNS }
    )
  })

  test('no group is rendered empty', () => {
    fc.assert(
      fc.property(uniqueSeries, (series) => {
        for (const group of groupForPanel(series)) expect(group.rows.length).toBeGreaterThan(0)
      }),
      { numRuns: RUNS }
    )
  })

  test('an unknown or absent category files under other, never under medications', () => {
    const groups = groupForPanel([
      observationSeries('a', 'unheard-of', [DateTime.unsafeMake(0)]),
      observationSeries('b', null, [DateTime.unsafeMake(0)]),
    ])
    expect(groups.map((group) => group.id)).toEqual([OTHER_GROUP])
    expect(groups[0].rows).toHaveLength(2)
  })

  test("a row's count and span describe its series", () => {
    fc.assert(
      fc.property(fc.array(instant, { maxLength: 6 }), (times) => {
        const row = groupForPanel([observationSeries('a', 'laboratory', times)])[0].rows[0]
        expect(row.count).toBe(times.length)
        if (times.length === 0) {
          expect(row.span).toBeNull()
        } else {
          const millis = times.map((time) => time.epochMillis)
          expect(row.span?.[0].epochMillis).toBe(Math.min(...millis))
          expect(row.span?.[1].epochMillis).toBe(Math.max(...millis))
        }
      }),
      { numRuns: RUNS }
    )
  })

  test("a medication row's span covers its segments", () => {
    const row = groupForPanel([medicationSeries('insulin')])[0].rows[0]
    expect(row.count).toBe(1)
    expect(row.span).toEqual([DateTime.unsafeMake(0), DateTime.unsafeMake(86_400_000)])
  })
})

describe('matchesSearch', () => {
  const row = (label: string, unit: string | null = null): CatalogRow => ({
    id: 'id',
    label,
    unit,
    count: 0,
    span: null,
  })

  test('an empty or whitespace-only query matches everything', () => {
    fc.assert(
      fc.property(fc.string(), fc.stringMatching(/^[\s]{0,4}$/), (label, query) => {
        expect(matchesSearch(row(label), query)).toBe(true)
      }),
      { numRuns: RUNS }
    )
  })

  test('a label always matches itself, however it is cased or spaced', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9 ]{1,20}$/), (label) => {
        fc.pre(/[A-Za-z0-9]/.test(label))
        expect(matchesSearch(row(label), label.toUpperCase())).toBe(true)
        expect(matchesSearch(row(label), label.toLowerCase())).toBe(true)
      }),
      { numRuns: RUNS }
    )
  })

  test('token order does not matter', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z]{2,6}$/), { minLength: 2, maxLength: 4 }),
        (tokens) => {
          const subject = row(tokens.join(' '))
          expect(matchesSearch(subject, tokens.toSorted().join(' '))).toBe(true)
          expect(matchesSearch(subject, tokens.toReversed().join(' '))).toBe(true)
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('diacritics are normalised away on both sides', () => {
    expect(matchesSearch(row('Créatinine'), 'creatinine')).toBe(true)
    expect(matchesSearch(row('Creatinine'), 'créatinine')).toBe(true)
  })

  test('a partial word matches, so typing narrows as you go', () => {
    expect(matchesSearch(row('Glucose'), 'gluc')).toBe(true)
    expect(matchesSearch(row('Glucose'), 'glucoses')).toBe(false)
  })

  test('the unit is searchable — it is what tells two same-code rows apart', () => {
    expect(matchesSearch(row('Glucose', 'mmol/L'), 'mmol')).toBe(true)
    expect(matchesSearch(row('Glucose', 'mg/dL'), 'mmol')).toBe(false)
  })

  test('numbers and dosage units are kept, not stripped as noise', () => {
    // The reason this package tokenizes locally instead of reusing
    // `medication-core`'s `normalizeName`, which drops both as matching noise.
    expect(matchesSearch(row('Hemoglobin A1c'), 'a1c')).toBe(true)
    expect(matchesSearch(row('Urine output', '24h'), '24h')).toBe(true)
  })

  test('every query token must be present, not just one of them', () => {
    expect(matchesSearch(row('Glucose'), 'glucose insulin')).toBe(false)
  })
})
