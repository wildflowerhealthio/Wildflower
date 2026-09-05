import * as fc from 'fast-check'
import type { SupplyDuration } from 'fhir-utility'
import { describe, expect, test } from 'vite-plus/test'

import { nextFillDate } from './supply.ts'

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
