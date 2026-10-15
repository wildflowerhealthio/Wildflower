import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { type DateTime, Either } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import {
  type SupplyDuration,
  supplyDurationToParts,
  type UnusableSupplyDuration,
} from './supply-duration.ts'

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

// The parts a usable supply parses to; throws (failing the test) on a left.
const partsOf = (over: Partial<SupplyDuration>): Partial<DateTime.DateTime.PartsForMath> =>
  Either.getOrThrow(supplyDurationToParts(supply(over)))

// The failure an unusable supply parses to, asserting it is a left.
const failureOf = (over: Partial<SupplyDuration>): UnusableSupplyDuration => {
  const result = supplyDurationToParts(supply(over))
  expect(Either.isLeft(result)).toBe(true)
  return Either.getOrThrow(Either.flip(result))
}

describe('supplyDurationToParts', () => {
  test('an absent value fails as SupplyDurationValueAbsent', () => {
    for (const value of [null, undefined]) {
      expect(failureOf({ value })._tag).toBe('SupplyDurationValueAbsent')
    }
  })

  test('a value that is not finite fails as SupplyDurationValueNotFinite, carrying it', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        fc.constantFrom(null, ...Object.keys(ucumParts)),
        (value, code) => {
          expect(failureOf({ code, value })).toMatchObject({
            _tag: 'SupplyDurationValueNotFinite',
            value,
          })
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('a value that rounds to less than one unit fails as SupplyDurationBelowOneUnit, carrying it', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ max: 0 }),
          fc.double({ min: -1e9, max: 0.49, noNaN: true, noDefaultInfinity: true })
        ),
        fc.constantFrom(null, ...Object.keys(ucumParts)),
        (value, code) => {
          expect(failureOf({ code, value })).toMatchObject({
            _tag: 'SupplyDurationBelowOneUnit',
            value,
          })
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('each UCUM code maps to its part, with the rounded value', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(ucumParts)),
        fc.integer({ min: 1, max: 500 }),
        (code, value) => {
          expect(partsOf({ code, value })).toEqual({
            [ucumParts[code]]: value,
          })
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('rounds a fractional value', () => {
    expect(partsOf({ code: 'd', value: 29.6 })).toEqual({ days: 30 })
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
          expect(partsOf({ unit, value })).toEqual({ [cases[unit]]: value })
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('an unrecognized (or absent) unit falls back to days', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant<null | undefined>(null), fc.constant(undefined), fc.constant('doses')),
        fc.integer({ min: 1, max: 500 }),
        (unit, value) => {
          expect(partsOf({ unit, code: '{dose}', value })).toEqual({
            days: value,
          })
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('a code or unit naming an Object.prototype key falls back to days', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'),
        fc.integer({ min: 1, max: 500 }),
        (key, value) => {
          expect(partsOf({ code: key, value })).toEqual({ days: value })
          expect(partsOf({ unit: key, value })).toEqual({ days: value })
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('a UCUM code wins over a conflicting spelled unit', () => {
    expect(partsOf({ code: 'wk', unit: 'days', value: 2 })).toEqual({
      weeks: 2,
    })
  })
})
