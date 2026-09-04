import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { nextFillDate, type SupplyDuration, supplyDurationToParts } from './supply.ts'

// The UCUM code -> expected `DateTime.add` part key mapping the parser encodes.
const ucumParts: Readonly<Record<string, string>> = {
  s: 'seconds',
  min: 'minutes',
  h: 'hours',
  d: 'days',
  wk: 'weeks',
  mo: 'months',
  a: 'years',
}

const supply = (over: Partial<SupplyDuration>): SupplyDuration => ({
  value: 30,
  unit: null,
  code: null,
  ...over,
})

describe('supplyDurationToParts', () => {
  test('a non-positive or absent value yields null', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant<null | undefined>(null),
          fc.constant(undefined),
          fc.integer({ max: 0 })
        ),
        (value) => {
          expect(supplyDurationToParts(supply({ value }))).toBeNull()
        }
      )
    )
  })

  test('each UCUM code maps to its part, with the rounded value', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(ucumParts)),
        fc.integer({ min: 1, max: 500 }),
        (code, value) => {
          expect(supplyDurationToParts(supply({ code, value }))).toEqual({
            [ucumParts[code]]: value,
          })
        }
      )
    )
  })

  test('rounds a fractional value', () => {
    expect(supplyDurationToParts(supply({ code: 'd', value: 29.6 }))).toEqual({ days: 30 })
  })

  test('spelled-out units are case-insensitive', () => {
    const cases: Readonly<Record<string, string>> = {
      day: 'days',
      days: 'days',
      Week: 'weeks',
      WEEKS: 'weeks',
      Month: 'months',
      months: 'months',
    }
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(cases)),
        fc.integer({ min: 1, max: 500 }),
        (unit, value) => {
          expect(supplyDurationToParts(supply({ unit, value }))).toEqual({ [cases[unit]]: value })
        }
      )
    )
  })

  test('an unrecognized (or absent) unit falls back to days', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant<null | undefined>(null), fc.constant(undefined), fc.constant('doses')),
        fc.integer({ min: 1, max: 500 }),
        (unit, value) => {
          expect(supplyDurationToParts(supply({ unit, code: '{dose}', value }))).toEqual({
            days: value,
          })
        }
      )
    )
  })

  test('a UCUM code wins over a conflicting spelled unit', () => {
    expect(supplyDurationToParts(supply({ code: 'wk', unit: 'days', value: 2 }))).toEqual({
      weeks: 2,
    })
  })
})

describe('nextFillDate', () => {
  test('advances a day-unit duration by exactly that many days', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3650 }), (days) => {
        const iso = nextFillDate('2026-06-01T00:00:00Z', supply({ code: 'd', value: days }))
        const expected = new Date(Date.UTC(2026, 5, 1 + days)).toISOString()
        expect(iso).toBe(expected)
      })
    )
  })

  test('a UCUM week code advances by whole weeks', () => {
    expect(nextFillDate('2026-06-01T00:00:00Z', supply({ code: 'wk', value: 2 }))).toBe(
      '2026-06-15T00:00:00.000Z'
    )
  })

  test('a spelled day unit advances by days', () => {
    expect(nextFillDate('2026-06-01T00:00:00Z', supply({ unit: 'days', value: 30 }))).toBe(
      '2026-07-01T00:00:00.000Z'
    )
  })

  test('an unusable supply duration yields null', () => {
    expect(nextFillDate('2026-06-01T00:00:00Z', supply({ value: 0 }))).toBeNull()
  })

  test('an unparseable authored date yields null', () => {
    expect(nextFillDate('not-a-date', supply({ code: 'd', value: 30 }))).toBeNull()
  })
})
