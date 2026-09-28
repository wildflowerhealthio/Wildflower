import { DateTime } from 'effect'
import * as fc from 'fast-check'
import type { LevelSeries, PointSeries } from 'health-viewer-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { type CatalogRow, groupForPanel, matchesSearch } from './catalog.ts'
import { CATALOG_GROUPS, type FiledSeries } from './series-sources.ts'

const RUNS = numRunsFor({ base: 200 })

const instant = fc.integer({ min: 0, max: 4e12 }).map((millis) => DateTime.unsafeMake(millis))

const pointSeries = (id: string, times: readonly DateTime.Utc[]): PointSeries.PointSeries => ({
  kind: 'points',
  id,
  label: id,
  unit: 'u',
  valueScale: 'fitted',
  interpolation: 'linear',
  points: times
    .toSorted((left, right) => left.epochMillis - right.epochMillis)
    .map((time) => ({ time, value: 1 })),
})

const levelSeries = (id: string): LevelSeries.LevelSeries => ({
  kind: 'levels',
  id,
  label: id,
  unit: 'mg',
  valueScale: 'from-zero',
  levels: [
    {
      start: DateTime.unsafeMake(0),
      end: DateTime.unsafeMake(86_400_000),
      value: 5,
      lineStyle: 'solid',
    },
  ],
})

const groupIdArb = fc.constantFrom(...CATALOG_GROUPS.map((group) => group.id))

const filedArb: fc.Arbitrary<FiledSeries> = fc.record({
  groupId: groupIdArb,
  series: fc.oneof(
    fc
      .record({ id: fc.stringMatching(/^[a-z]{1,6}$/), times: fc.array(instant, { maxLength: 5 }) })
      .map(({ id, times }) => pointSeries(id, times)),
    fc.stringMatching(/^[a-z]{1,6}$/).map(levelSeries)
  ),
})

/** Unique by series id, since two identical ids would collapse in a real catalogue. */
const uniqueFiled = fc.uniqueArray(filedArb, {
  maxLength: 10,
  selector: (filed) => filed.series.id,
})

describe('groupForPanel', () => {
  test('every series lands in exactly one group — the one it was filed under', () => {
    fc.assert(
      fc.property(uniqueFiled, (filed) => {
        const groups = groupForPanel(filed)
        const rows = groups.flatMap((group) => group.rows)
        expect(rows).toHaveLength(filed.length)
        for (const { groupId, series } of filed) {
          const holding = groups.filter((group) => group.rows.some((row) => row.id === series.id))
          expect(holding.map((group) => group.id)).toEqual([groupId])
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('groups follow the sources’ declared order, labelled as declared', () => {
    fc.assert(
      fc.property(uniqueFiled, (filed) => {
        const headings = groupForPanel(filed).map((group) => ({ id: group.id, label: group.label }))
        const shownIds = headings.map((heading) => heading.id)
        expect(headings).toEqual(CATALOG_GROUPS.filter((group) => shownIds.includes(group.id)))
      }),
      { numRuns: RUNS }
    )
  })

  test('no group is rendered empty', () => {
    fc.assert(
      fc.property(uniqueFiled, (filed) => {
        for (const group of groupForPanel(filed)) expect(group.rows.length).toBeGreaterThan(0)
      }),
      { numRuns: RUNS }
    )
  })

  test('a series filed under a group no source declares is an error, not a lost row', () => {
    expect(() => groupForPanel([{ groupId: 'unheard-of', series: pointSeries('a', []) }])).toThrow(
      /unheard-of/
    )
  })

  test("a row's count and span describe its series", () => {
    fc.assert(
      fc.property(fc.array(instant, { maxLength: 6 }), groupIdArb, (times, groupId) => {
        const row = groupForPanel([{ groupId, series: pointSeries('a', times) }])[0].rows[0]
        expect(row.seriesKind).toBe('points')
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

  test("a level series' span covers its levels", () => {
    const [groupId] = CATALOG_GROUPS.map((group) => group.id)
    const row = groupForPanel([{ groupId, series: levelSeries('insulin') }])[0].rows[0]
    expect(row.seriesKind).toBe('levels')
    expect(row.count).toBe(1)
    expect(row.span).toEqual([DateTime.unsafeMake(0), DateTime.unsafeMake(86_400_000)])
  })
})

describe('matchesSearch', () => {
  const row = (label: string, unit: string | null = null): CatalogRow => ({
    id: 'id',
    label,
    unit,
    seriesKind: 'points',
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
