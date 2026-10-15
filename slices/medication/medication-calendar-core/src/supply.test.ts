import type { SupplyDuration } from '@wildflowerhealthio/fhir-utility'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Either } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { nextFillDate, type NextFillDateFailure } from './supply.ts'

// The failure `nextFillDate` returns, asserting it is a left.
const failureOf = (authoredOnIso: string, over: Partial<SupplyDuration>): NextFillDateFailure => {
  const result = nextFillDate(authoredOnIso, supply(over))
  expect(Either.isLeft(result)).toBe(true)
  return Either.getOrThrow(Either.flip(result))
}

const supply = (over: Partial<SupplyDuration>): SupplyDuration => ({
  value: 30,
  unit: null,
  code: null,
  ...over,
})

describe('nextFillDate', () => {
  test('advances a day-unit duration by exactly that many days', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3650 }), (days) => {
        const iso = Either.getOrThrow(
          nextFillDate('2026-06-01T00:00:00Z', supply({ code: 'd', value: days }))
        )
        const expected = new Date(Date.UTC(2026, 5, 1 + days)).toISOString()
        expect(iso).toBe(expected)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('a UCUM week code advances by whole weeks', () => {
    expect(nextFillDate('2026-06-01T00:00:00Z', supply({ code: 'wk', value: 2 }))).toEqual(
      Either.right('2026-06-15T00:00:00.000Z')
    )
  })

  test('a spelled day unit advances by days', () => {
    expect(nextFillDate('2026-06-01T00:00:00Z', supply({ unit: 'days', value: 30 }))).toEqual(
      Either.right('2026-07-01T00:00:00.000Z')
    )
  })

  test("an unusable supply duration passes fhir-utility's failure through", () => {
    expect(failureOf('2026-06-01T00:00:00Z', { value: 0 })).toMatchObject({
      _tag: 'SupplyDurationBelowOneUnit',
      value: 0,
    })
    expect(failureOf('2026-06-01T00:00:00Z', { value: null })._tag).toBe(
      'SupplyDurationValueAbsent'
    )
    expect(failureOf('2026-06-01T00:00:00Z', { value: Number.NaN })._tag).toBe(
      'SupplyDurationValueNotFinite'
    )
  })

  test('the supply duration is checked before the authored date', () => {
    expect(failureOf('not-a-date', { value: 0 })._tag).toBe('SupplyDurationBelowOneUnit')
  })

  test('a supply duration that advances past the representable date range fails as NextFillDatePastRepresentableRange', () => {
    fc.assert(
      fc.property(fc.integer({ min: 300_000, max: 1_000_000_000 }), (years) => {
        expect(failureOf('2026-06-01T00:00:00Z', { code: 'a', value: years })._tag).toBe(
          'NextFillDatePastRepresentableRange'
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('an unparseable authored date fails as AuthoredDateUnparseable, carrying it', () => {
    expect(failureOf('not-a-date', { code: 'd', value: 30 })).toMatchObject({
      _tag: 'AuthoredDateUnparseable',
      authoredOnIso: 'not-a-date',
    })
  })
})
