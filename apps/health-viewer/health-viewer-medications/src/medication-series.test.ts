import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import type { DoseRegimen } from 'medication-core/fhir'
import { describe, expect, test } from 'vite-plus/test'

import { medicationSeriesIdOf } from './medication-series-key.ts'
import {
  AMORTIZED_DOSE_NOTE,
  DOSE_BASIS_NOTES,
  type MedicationSeries,
  displayUnitOf,
  doseRegimensToSeries,
} from './medication-series.ts'

const RUNS = numRunsFor({ base: 200 })

const at = (epochMillis: number): DateTime.Utc => DateTime.unsafeMake(epochMillis)

/**
 * A regimen as `medication-core/fhir` would read it, from a few names, units
 * and bases so regimens collide into shared series often. Times are small
 * epoch offsets so starts tie and intervals overlap often too.
 */
const regimenArb: fc.Arbitrary<DoseRegimen> = fc
  .record({
    // `''` is a name that normalised to nothing, which must not merge.
    normalizedName: fc.constantFrom('metformin', 'insulin glargine', ''),
    unit: fc.constantFrom('mg', 'mL', null),
    // An amortized dose is always per day.
    doseBasisAndDerivation: fc.constantFrom<Pick<DoseRegimen, 'per' | 'derivation'>>(
      { per: 'administration', derivation: 'stated' },
      { per: 'd', derivation: 'stated' },
      { per: 'd', derivation: 'amortized' }
    ),
    start: fc.integer({ min: 0, max: 1_000 }),
    length: fc.option(fc.integer({ min: 0, max: 400 }), { nil: null }),
    amount: fc.double({ min: 0, max: 1e4, noNaN: true }),
    rangeLow: fc.option(fc.double({ min: 0, max: 1e4, noNaN: true }), { nil: null }),
    status: fc.constantFrom<DoseRegimen['status']>('active', 'completed', 'stopped', 'on-hold'),
    name: fc.string({ maxLength: 12 }),
  })
  .map(({ start, length, doseBasisAndDerivation, ...rest }) => ({
    ...rest,
    ...doseBasisAndDerivation,
    requestId: '',
    start: at(start),
    end: length === null ? null : at(start + length),
  }))

/** Regimens with unique request ids, so each level traces back to its regimen. */
const regimensArb: fc.Arbitrary<readonly DoseRegimen[]> = fc
  .array(regimenArb, { maxLength: 10 })
  .map((regimens) => regimens.map((regimen, index) => ({ ...regimen, requestId: `mr-${index}` })))

/** The regimen each of a series' levels was read from, in level order. */
const regimensOf = (
  series: MedicationSeries,
  regimens: readonly DoseRegimen[]
): readonly DoseRegimen[] =>
  series.levels.map((doseLevel) => {
    const regimen = regimens.find((candidate) => candidate.requestId === doseLevel.requestId)
    if (regimen === undefined) throw new Error(`no regimen for ${doseLevel.requestId}`)
    return regimen
  })

/** Each element of `items` beside the one after it. */
const adjacentPairs = <T>(items: readonly T[]): readonly (readonly [T, T])[] =>
  items.slice(1).map((later, index) => [items[index], later] as const)

describe('doseRegimensToSeries', () => {
  test('every regimen lands in exactly one level', () => {
    fc.assert(
      fc.property(regimensArb, (regimens) => {
        const requestIds = doseRegimensToSeries(regimens).flatMap((series) =>
          series.levels.map((doseLevel) => doseLevel.requestId)
        )
        expect(requestIds.toSorted()).toEqual(
          regimens.map((regimen) => regimen.requestId).toSorted()
        )
      }),
      { numRuns: RUNS }
    )
  })

  test("a series' levels are start-sorted and never overlap", () => {
    fc.assert(
      fc.property(regimensArb, (regimens) => {
        for (const series of doseRegimensToSeries(regimens)) {
          for (const [earlier, later] of adjacentPairs(series.levels)) {
            expect(earlier.start.epochMillis).toBeLessThanOrEqual(later.start.epochMillis)
            expect(earlier.end).not.toBeNull()
            expect(earlier.end?.epochMillis).toBeLessThanOrEqual(later.start.epochMillis)
            expect(earlier.start.epochMillis).toBeLessThanOrEqual(
              earlier.end?.epochMillis ?? Number.NaN
            )
          }
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('a later regimen clips an earlier one exactly at its start, and leaves one that ended sooner alone', () => {
    fc.assert(
      fc.property(regimensArb, (regimens) => {
        for (const series of doseRegimensToSeries(regimens)) {
          const seriesRegimens = regimensOf(series, regimens)
          series.levels.forEach((doseLevel, index) => {
            const regimen = seriesRegimens[index]
            const nextRegimen = seriesRegimens[index + 1]
            const overruns =
              nextRegimen !== undefined &&
              (regimen.end === null || regimen.end.epochMillis > nextRegimen.start.epochMillis)
            expect(doseLevel.start).toEqual(regimen.start)
            expect(doseLevel.end).toEqual(overruns ? nextRegimen.start : regimen.end)
          })
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('regimens with a different medication, dose unit or dose basis never share a series', () => {
    fc.assert(
      fc.property(regimensArb, (regimens) => {
        for (const series of doseRegimensToSeries(regimens)) {
          expect(series.id).toBe(medicationSeriesIdOf(series.key))
          for (const regimen of regimensOf(series, regimens)) {
            expect(series.key).toEqual({
              medication:
                regimen.normalizedName === '' ? `#${regimen.requestId}` : regimen.normalizedName,
              doseUnit: regimen.unit,
              doseBasis: regimen.per,
            })
          }
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('series ids are distinct', () => {
    fc.assert(
      fc.property(regimensArb, (regimens) => {
        const ids = doseRegimensToSeries(regimens).map((series) => series.id)
        expect(new Set(ids).size).toBe(ids.length)
      }),
      { numRuns: RUNS }
    )
  })

  test('of regimens starting together, the longer-running sorts later; full ties keep input order', () => {
    fc.assert(
      fc.property(regimensArb, (regimens) => {
        const inputIndexOf = (regimen: DoseRegimen): number => regimens.indexOf(regimen)
        const endOrInfinity = (regimen: DoseRegimen): number =>
          regimen.end === null ? Number.POSITIVE_INFINITY : regimen.end.epochMillis
        for (const series of doseRegimensToSeries(regimens)) {
          for (const [earlier, later] of adjacentPairs(regimensOf(series, regimens))) {
            if (earlier.start.epochMillis !== later.start.epochMillis) continue
            expect(endOrInfinity(earlier)).toBeLessThanOrEqual(endOrInfinity(later))
            if (endOrInfinity(earlier) === endOrInfinity(later)) {
              expect(inputIndexOf(earlier)).toBeLessThan(inputIndexOf(later))
            }
          }
        }
      }),
      { numRuns: RUNS }
    )
  })

  test("each level carries its regimen's dose, band, basis or amortized note, and hold style", () => {
    fc.assert(
      fc.property(regimensArb, (regimens) => {
        for (const series of doseRegimensToSeries(regimens)) {
          const seriesRegimens = regimensOf(series, regimens)
          series.levels.forEach((doseLevel, index) => {
            const regimen = seriesRegimens[index]
            expect(doseLevel.value).toBe(regimen.amount)
            expect(doseLevel.note).toBe(
              regimen.derivation === 'amortized'
                ? AMORTIZED_DOSE_NOTE
                : DOSE_BASIS_NOTES[regimen.per]
            )
            expect(doseLevel.lineStyle === 'dashed').toBe(regimen.status === 'on-hold')
            if (regimen.rangeLow === null) {
              expect('low' in doseLevel).toBe(false)
            } else {
              expect(doseLevel.low).toBe(regimen.rangeLow)
            }
            expect('high' in doseLevel).toBe(false)
          })
        }
      }),
      { numRuns: RUNS }
    )
  })

  test("a series is labelled with its last regimen's display name, in its key's unit, from zero", () => {
    fc.assert(
      fc.property(regimensArb, (regimens) => {
        for (const series of doseRegimensToSeries(regimens)) {
          const seriesRegimens = regimensOf(series, regimens)
          expect(series.kind).toBe('levels')
          expect(series.label).toBe(seriesRegimens[seriesRegimens.length - 1].name)
          expect(series.unit).toBe(displayUnitOf(series.key))
          expect(series.valueScale).toBe('from-zero')
        }
      }),
      { numRuns: RUNS }
    )
  })

  describe('examples', () => {
    /** A metformin 500 mg per-dose regimen from the epoch, open-ended, overlaid with `overrides`. */
    const regimen = (
      overrides: Partial<DoseRegimen> & Pick<DoseRegimen, 'requestId'>
    ): DoseRegimen => ({
      name: 'Metformin 500 mg',
      normalizedName: 'metformin',
      status: 'active',
      amount: 500,
      rangeLow: null,
      unit: 'mg',
      per: 'administration',
      derivation: 'stated',
      start: at(0),
      end: null,
      ...overrides,
    })

    test('a dose change reads as two steps of one line, the old dose ending where the new one starts', () => {
      const march = DateTime.unsafeMake('2026-03-01T00:00:00Z')
      const january = DateTime.unsafeMake('2026-01-01T00:00:00Z')
      const series = doseRegimensToSeries([
        regimen({ requestId: 'mr-2', name: 'Metformin 1000 mg', amount: 1000, start: march }),
        regimen({ requestId: 'mr-1', start: january }),
      ])
      expect(series).toEqual([
        {
          kind: 'levels',
          id: 'm:metformin|mg|administration',
          key: { medication: 'metformin', doseUnit: 'mg', doseBasis: 'administration' },
          label: 'Metformin 1000 mg',
          unit: 'mg',
          valueScale: 'from-zero',
          levels: [
            {
              start: january,
              end: march,
              value: 500,
              note: 'per dose',
              lineStyle: 'solid',
              requestId: 'mr-1',
            },
            {
              start: march,
              end: null,
              value: 1000,
              note: 'per dose',
              lineStyle: 'solid',
              requestId: 'mr-2',
            },
          ],
        },
      ])
    })

    test('a per-dose and a per-day regimen of one drug are two series, told apart by unit', () => {
      const series = doseRegimensToSeries([
        regimen({ requestId: 'mr-dose' }),
        regimen({ requestId: 'mr-day', amount: 1000, per: 'd' }),
      ])
      expect(series.map((one) => [one.id, one.unit, one.levels[0].note])).toEqual([
        ['m:metformin|mg|administration', 'mg', 'per dose'],
        ['m:metformin|mg|d', 'mg/d', 'per day'],
      ])
    })

    test('a stated and an amortized daily dose of one drug share a series, told apart by note', () => {
      const march = DateTime.unsafeMake('2026-03-01T00:00:00Z')
      const series = doseRegimensToSeries([
        regimen({ requestId: 'mr-stated', amount: 1000, per: 'd' }),
        regimen({
          requestId: 'mr-amortized',
          amount: 1000,
          per: 'd',
          derivation: 'amortized',
          start: march,
        }),
      ])
      expect(series.map((one) => [one.id, one.levels.map((doseLevel) => doseLevel.note)])).toEqual([
        ['m:metformin|mg|d', ['per day', 'per day, amortized over the supply']],
      ])
    })

    test('a unitless daily total is shown as per day', () => {
      expect(displayUnitOf({ medication: 'x', doseUnit: null, doseBasis: 'd' })).toBe('/d')
      expect(displayUnitOf({ medication: 'x', doseUnit: null, doseBasis: 'administration' })).toBe(
        null
      )
    })

    test('of two regimens starting together, the open one stays in effect whatever the input order', () => {
      const active = regimen({ requestId: 'mr-active' })
      const stopped = regimen({ requestId: 'mr-stopped', status: 'stopped', end: at(0) })
      for (const input of [
        [active, stopped],
        [stopped, active],
      ]) {
        const [series] = doseRegimensToSeries(input)
        expect(series.levels.map((doseLevel) => [doseLevel.requestId, doseLevel.end])).toEqual([
          ['mr-stopped', at(0)],
          ['mr-active', null],
        ])
      }
    })

    test('regimens whose names normalise to nothing each form their own series', () => {
      const series = doseRegimensToSeries([
        regimen({ requestId: 'mr-1', name: '500 mg', normalizedName: '' }),
        regimen({ requestId: 'mr-2', name: '500 mg', normalizedName: '', start: at(10) }),
      ])
      expect(series.map((one) => one.key.medication)).toEqual(['#mr-1', '#mr-2'])
      expect(series.map((one) => one.levels[0].end)).toEqual([null, null])
    })

    test("a dose range's floor is the level's low, and an on-hold request is dashed", () => {
      const [series] = doseRegimensToSeries([
        regimen({ requestId: 'mr-range', amount: 10, rangeLow: 4 }),
        regimen({ requestId: 'mr-held', start: at(10), status: 'on-hold' }),
      ])
      expect(series.levels.map((doseLevel) => [doseLevel.low, doseLevel.lineStyle])).toEqual([
        [4, 'solid'],
        [undefined, 'dashed'],
      ])
    })
  })
})
