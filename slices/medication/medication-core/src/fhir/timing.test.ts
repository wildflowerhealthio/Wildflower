import { Timing } from '@wildflowerhealthio/fhir-r4/data-types'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { DAYS_PER_PERIOD_UNIT, scaleToDailyTotal } from './timing.ts'

describe('scaleToDailyTotal', () => {
  test('scales exactly when frequency, a positive period and a known unit are stated', () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        Arbitrary.make(Timing.Schema),
        Arbitrary.make(Timing.TimingRepeatSchema),
        (amountPerAdministration, timing, timingRepeat) => {
          const scheduledTiming = { ...timing, repeat: timingRepeat }
          const { frequency, period, periodUnit } = timingRepeat
          const daysPerPeriodUnit =
            periodUnit === null ? undefined : DAYS_PER_PERIOD_UNIT[periodUnit]
          const periodInDays =
            period === null || daysPerPeriodUnit === undefined ? null : period * daysPerPeriodUnit
          const dailyTotal = scaleToDailyTotal(amountPerAdministration, scheduledTiming)
          if (frequency !== null && periodInDays !== null && periodInDays > 0) {
            expect(dailyTotal).toBe((amountPerAdministration * frequency) / periodInDays)
          } else {
            expect(dailyTotal).toBeNull()
          }
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('is null without a timing or a repeat', () => {
    expect(scaleToDailyTotal(10, null)).toBeNull()
    expect(scaleToDailyTotal(10, Schema.decodeUnknownSync(Timing.Schema)({}))).toBeNull()
  })

  test('normalizes each known period unit to a day, with a month as 30 days', () => {
    const dailyTotalOfTenThrice = (period: number, periodUnit: string): number | null =>
      scaleToDailyTotal(
        10,
        Schema.decodeUnknownSync(Timing.Schema)({ repeat: { frequency: 3, period, periodUnit } })
      )

    expect(dailyTotalOfTenThrice(8, 'h')).toBe(90)
    expect(dailyTotalOfTenThrice(1, 'd')).toBe(30)
    expect(dailyTotalOfTenThrice(1, 'wk')).toBe(30 / 7)
    expect(dailyTotalOfTenThrice(1, 'mo')).toBe(1)
    // Seconds, minutes and years are not normalised units.
    expect(dailyTotalOfTenThrice(1, 'a')).toBeNull()
    expect(dailyTotalOfTenThrice(1, 'min')).toBeNull()
    expect(dailyTotalOfTenThrice(1, 's')).toBeNull()
  })
})
