import type { MedicationRequest } from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { firstDoseOf } from './dosage.ts'
import { medicationRequestWithIdArb } from './medication-request-arbitrary.ts'
import { base, decode } from './test-helpers.ts'
import { DAYS_PER_PERIOD_UNIT } from './timing.ts'

/** The first instruction's first stated amount, before any daily scaling. */
const statedAmountOf = (request: MedicationRequest.Type): number | null => {
  const firstDoseAndRate = request.dosageInstruction[0]?.doseAndRate[0]
  return firstDoseAndRate?.doseQuantity?.value ?? firstDoseAndRate?.doseRange?.high?.value ?? null
}

/** A request whose only content is the given `dosageInstruction`, as wire JSON. */
const requestWithDosage = (dosageInstruction: unknown[]): MedicationRequest.Type =>
  decode({ ...base, dosageInstruction })

describe('firstDoseOf', () => {
  test("is stated, and per 'd' exactly when frequency, a positive period and a known unit are stated, and scales the amount to a day", () => {
    fc.assert(
      fc.property(medicationRequestWithIdArb, (request) => {
        const firstDose = firstDoseOf(request)
        if (firstDose === null) return
        expect(firstDose.derivation).toBe('stated')
        const timingRepeat = request.dosageInstruction[0].timing?.repeat ?? null
        const daysPerPeriodUnit =
          timingRepeat === null || timingRepeat.periodUnit === null
            ? undefined
            : DAYS_PER_PERIOD_UNIT[timingRepeat.periodUnit]
        const frequency = timingRepeat?.frequency ?? null
        const periodInDays =
          timingRepeat === null || timingRepeat.period === null || daysPerPeriodUnit === undefined
            ? null
            : timingRepeat.period * daysPerPeriodUnit
        const statedAmount = statedAmountOf(request)
        if (
          frequency !== null &&
          periodInDays !== null &&
          periodInDays > 0 &&
          statedAmount !== null
        ) {
          expect(firstDose.per).toBe('d')
          expect(firstDose.amount).toBe((statedAmount * frequency) / periodInDays)
        } else {
          expect(firstDose.per).toBe('administration')
          expect(firstDose.amount).toBe(statedAmount)
        }
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('reads a dose quantity and its unit, falling back to the UCUM code', () => {
    expect(
      firstDoseOf(
        requestWithDosage([{ doseAndRate: [{ doseQuantity: { value: 500, unit: 'mg' } }] }])
      )
    ).toEqual({
      amount: 500,
      rangeLow: null,
      unit: 'mg',
      per: 'administration',
      derivation: 'stated',
    })
    expect(
      firstDoseOf(
        requestWithDosage([{ doseAndRate: [{ doseQuantity: { value: 500, code: 'mg' } }] }])
      )?.unit
    ).toBe('mg')
  })

  test('reads a dose range at its high and keeps its low as the band floor, both scaled per day', () => {
    const firstDose = firstDoseOf(
      requestWithDosage([
        {
          timing: { repeat: { frequency: 2, period: 1, periodUnit: 'd' } },
          doseAndRate: [
            { doseRange: { low: { value: 250, unit: 'mg' }, high: { value: 500, unit: 'mg' } } },
          ],
        },
      ])
    )
    expect(firstDose).toEqual({
      amount: 1000,
      rangeLow: 500,
      unit: 'mg',
      per: 'd',
      derivation: 'stated',
    })
  })

  test("drops a dose range's floor stated in a different unit than its high", () => {
    const firstDose = firstDoseOf(
      requestWithDosage([
        {
          doseAndRate: [
            { doseRange: { low: { value: 0.25, unit: 'g' }, high: { value: 500, unit: 'mg' } } },
          ],
        },
      ])
    )
    expect(firstDose).toEqual({
      amount: 500,
      rangeLow: null,
      unit: 'mg',
      per: 'administration',
      derivation: 'stated',
    })
  })

  test('reads only the first instruction and its first doseAndRate', () => {
    const firstDose = firstDoseOf(
      requestWithDosage([
        {
          doseAndRate: [
            { doseQuantity: { value: 500, unit: 'mg' } },
            { doseQuantity: { value: 1000, unit: 'mg' } },
          ],
        },
        { doseAndRate: [{ doseQuantity: { value: 2000, unit: 'mg' } }] },
      ])
    )
    expect(firstDose?.amount).toBe(500)
  })

  test('is null when no dose quantity or range high carries a value', () => {
    expect(firstDoseOf(requestWithDosage([]))).toBeNull()
    expect(firstDoseOf(requestWithDosage([{ doseAndRate: [] }]))).toBeNull()
    expect(
      firstDoseOf(requestWithDosage([{ doseAndRate: [{ doseQuantity: { unit: 'mg' } }] }]))
    ).toBeNull()
    expect(
      firstDoseOf(
        requestWithDosage([{ doseAndRate: [{ doseRange: { low: { value: 1, unit: 'mg' } } }] }])
      )
    ).toBeNull()
  })
})
