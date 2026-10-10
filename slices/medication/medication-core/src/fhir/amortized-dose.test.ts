import type { MedicationRequest } from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { amortizedDoseOf } from './amortized-dose.ts'
import { supplyDaysPerFillOf } from './dispense-request.ts'
import type { Dose } from './dosage.ts'
import { medicationRequestWithIdArb } from './medication-request-arbitrary.ts'
import { amortizableRexallRequest, base, decode } from './test-helpers.ts'

const RUNS = numRunsFor({ base: 50 })

/** A request that states no dose, carrying `dispenseRequest` and `contained` as wire JSON. */
const requestWithSupply = (
  dispenseRequest: Record<string, unknown>,
  contained: unknown[] = []
): MedicationRequest.Type => decode({ ...base, dosageInstruction: [], dispenseRequest, contained })

/** A contained Medication with one ingredient of the given `strength`, as wire JSON. */
const medicationWithStrength = (strength: Record<string, unknown>): Record<string, unknown> => ({
  resourceType: 'Medication',
  ingredient: [{ itemCodeableConcept: { text: 'Drug' }, strength }],
})

/** 30 capsules over 30 days: one capsule a day. */
const thirtyCapsulesOverThirtyDays = {
  quantity: { value: 30, unit: 'capsule' },
  expectedSupplyDuration: { value: 30, code: 'd' },
}

describe('amortizedDoseOf', () => {
  test('an amortized dose is always a flagged daily total with no range floor', () => {
    fc.assert(
      fc.property(medicationRequestWithIdArb, (request) => {
        const amortizedDose = amortizedDoseOf(request)
        if (amortizedDose === null) return
        expect(amortizedDose.per).toBe('d')
        expect(amortizedDose.derivation).toBe('amortized')
        expect(amortizedDose.rangeLow).toBeNull()
      }),
      { numRuns: RUNS }
    )
  })

  test('there is no amortized dose without a positive dispensed quantity and supply duration', () => {
    fc.assert(
      fc.property(medicationRequestWithIdArb, (request) => {
        const dispensedAmount = request.dispenseRequest?.quantity?.value ?? null
        const supplyDaysPerFill = supplyDaysPerFillOf(request)
        if (dispensedAmount === null || dispensedAmount <= 0 || supplyDaysPerFill === null) {
          expect(amortizedDoseOf(request)).toBeNull()
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('is null for a missing, zero or negative quantity or supply duration', () => {
    const unusableQuantityArb = fc.oneof(
      fc.constant({}),
      fc.integer({ min: -90, max: 0 }).map((value) => ({ quantity: { value, unit: 'capsule' } }))
    )
    const unusableSupplyDurationArb = fc.oneof(
      fc.constant({}),
      fc
        .integer({ min: -90, max: 0 })
        .map((value) => ({ expectedSupplyDuration: { value, code: 'd' } }))
    )
    fc.assert(
      fc.property(unusableQuantityArb, unusableSupplyDurationArb, (quantity, supplyDuration) => {
        const { quantity: usableQuantity, expectedSupplyDuration: usableSupplyDuration } =
          thirtyCapsulesOverThirtyDays
        expect(
          amortizedDoseOf(
            requestWithSupply({ ...quantity, expectedSupplyDuration: usableSupplyDuration })
          )
        ).toBeNull()
        expect(
          amortizedDoseOf(requestWithSupply({ quantity: usableQuantity, ...supplyDuration }))
        ).toBeNull()
      }),
      { numRuns: RUNS }
    )
  })

  test('is the quantity times the strength per dispensed unit over the supply days, exactly', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),
        fc.double({ min: 0.001, max: 1000, noNaN: true }),
        fc.integer({ min: 1, max: 365 }),
        fc.constantFrom('mg', 'mL', 'mcg'),
        (dispensedAmount, strengthAmount, supplyDays, strengthUnit) => {
          const amortizedDose = amortizedDoseOf(
            requestWithSupply(
              {
                quantity: { value: dispensedAmount, unit: 'tablet' },
                expectedSupplyDuration: { value: supplyDays, code: 'd' },
              },
              [
                medicationWithStrength({
                  numerator: { value: strengthAmount, unit: strengthUnit },
                  denominator: { value: 1 },
                }),
              ]
            )
          )
          expect(amortizedDose).toEqual({
            amount: (dispensedAmount * strengthAmount) / supplyDays,
            rangeLow: null,
            unit: strengthUnit,
            per: 'd',
            derivation: 'amortized',
          })
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('is the quantity over the supply days, in the dispensed unit, without a usable strength', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 1, max: 365 }),
        (dispensedAmount, supplyDays) => {
          const amortizedDose = amortizedDoseOf(
            requestWithSupply({
              quantity: { value: dispensedAmount, unit: 'capsule' },
              expectedSupplyDuration: { value: supplyDays, code: 'd' },
            })
          )
          expect(amortizedDose?.amount).toBe(dispensedAmount / supplyDays)
          expect(amortizedDose?.unit).toBe('capsule')
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('reads a carebook import as 10 mg/day, amortized', () => {
    expect(amortizedDoseOf(decode(amortizableRexallRequest))).toEqual({
      amount: 10,
      rangeLow: null,
      unit: 'mg',
      per: 'd',
      derivation: 'amortized',
    })
  })

  test('converts a supply stated in weeks to days', () => {
    expect(
      amortizedDoseOf(
        requestWithSupply({
          quantity: { value: 28, unit: 'tablet' },
          expectedSupplyDuration: { value: 2, code: 'wk' },
        })
      )?.amount
    ).toBe(2)
  })

  test('scales by a strength whose denominator is one dispensed unit, by unit or unstated', () => {
    const doseWithDenominator = (denominator: Record<string, unknown>): Dose | null =>
      amortizedDoseOf(
        requestWithSupply(thirtyCapsulesOverThirtyDays, [
          medicationWithStrength({ numerator: { value: 20, unit: 'mg' }, denominator }),
        ])
      )
    expect(doseWithDenominator({ value: 1 })).toMatchObject({ amount: 20, unit: 'mg' })
    expect(doseWithDenominator({ value: 1, unit: 'capsule' })).toMatchObject({
      amount: 20,
      unit: 'mg',
    })
    expect(doseWithDenominator({ value: 1, unit: 'mL' })).toMatchObject({
      amount: 1,
      unit: 'capsule',
    })
    expect(doseWithDenominator({ value: 5, unit: 'capsule' })).toMatchObject({
      amount: 1,
      unit: 'capsule',
    })
  })

  test('stays in dispensed units for a Medication with no ingredient or several', () => {
    const tenMilligramsPerUnit = {
      itemCodeableConcept: { text: 'Drug' },
      strength: { numerator: { value: 10, unit: 'mg' }, denominator: { value: 1 } },
    }
    for (const ingredient of [[], [tenMilligramsPerUnit, tenMilligramsPerUnit]]) {
      expect(
        amortizedDoseOf(
          requestWithSupply(thirtyCapsulesOverThirtyDays, [
            { resourceType: 'Medication', ingredient },
          ])
        )
      ).toMatchObject({ amount: 1, unit: 'capsule' })
    }
  })

  test('reads the strength of the contained Medication the request references', () => {
    const request = decode({
      ...base,
      dosageInstruction: [],
      dispenseRequest: thirtyCapsulesOverThirtyDays,
      medicationReference: { reference: '#referenced' },
      contained: [
        {
          id: 'other',
          ...medicationWithStrength({
            numerator: { value: 5, unit: 'mg' },
            denominator: { value: 1 },
          }),
        },
        {
          id: 'referenced',
          ...medicationWithStrength({
            numerator: { value: 40, unit: 'mg' },
            denominator: { value: 1 },
          }),
        },
      ],
    })
    expect(amortizedDoseOf(request)).toMatchObject({ amount: 40, unit: 'mg' })
  })
})
