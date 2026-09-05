import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { type SupplyDuration, supplyDurationToParts } from './supply-duration.ts'

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
