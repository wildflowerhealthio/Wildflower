import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { expectedSigOf, productArbitrary, dosingArbitrary } from './arbitraries.test-helpers.ts'
import type * as DrugProduct from './drug-product.ts'
import * as Prescription from './prescription.ts'

const RUNS = numRunsFor({ base: 200 })

const supplyDaysArbitrary = fc.integer({ min: 1, max: 100 })
const refillDaysLateArbitrary = fc.array(fc.integer({ min: 0, max: 14 }), { maxLength: 12 })

/** A prescription with every field the functions under test read left free. */
const prescriptionArbitrary: fc.Arbitrary<Prescription.Prescription> = fc
  .record({
    product: productArbitrary,
    dosing: dosingArbitrary,
    supplyDaysPerFill: supplyDaysArbitrary,
    repeatsAllowed: fc.integer({ min: 0, max: 12 }),
    firstFillDay: fc.integer({ min: -600, max: -1 }),
    refillDaysLate: refillDaysLateArbitrary,
    ended: fc.option(
      fc.record({
        day: fc.integer({ min: -600, max: 0 }),
        reason: fc.constantFrom<Prescription.EndReason>(
          'dose-change',
          'hold',
          'generic-switch',
          'stop'
        ),
      })
    ),
  })
  .filter(({ repeatsAllowed, refillDaysLate }) => refillDaysLate.length <= repeatsAllowed)
  .map(({ firstFillDay, refillDaysLate, ...rest }) => ({
    ...rest,
    key: 'rx',
    prescriber: { key: 'doctor', display: 'DR A DOCTOR' },
    written: { day: firstFillDay, reason: 'start' as const },
    fillDays: Prescription.fillDaysOnCadence(firstFillDay, rest.supplyDaysPerFill, refillDaysLate),
  }))

describe('Prescription.fillDaysOnCadence', () => {
  test('property: each refill falls one supply after the last, plus the days it was late', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -600, max: 0 }),
        supplyDaysArbitrary,
        refillDaysLateArbitrary,
        (firstFillDay, supplyDays, refillDaysLate) => {
          const fillDays = Prescription.fillDaysOnCadence(firstFillDay, supplyDays, refillDaysLate)
          expect(fillDays).toHaveLength(refillDaysLate.length + 1)
          expect(fillDays[0]).toBe(firstFillDay)
          refillDaysLate.forEach((daysLate, index) => {
            expect((fillDays[index + 1] ?? Number.NaN) - (fillDays[index] ?? Number.NaN)).toBe(
              supplyDays + daysLate
            )
          })
        }
      ),
      { numRuns: RUNS }
    )
  })
})

describe('Prescription.repeatsRemainingOf', () => {
  test('property: every fill after the first uses one repeat, never going negative', () => {
    fc.assert(
      fc.property(prescriptionArbitrary, (prescription) => {
        const repeatsRemaining = Prescription.repeatsRemainingOf(prescription)
        expect(repeatsRemaining).toBe(
          prescription.repeatsAllowed - (prescription.fillDays.length - 1)
        )
        expect(repeatsRemaining).toBeGreaterThanOrEqual(0)
      }),
      { numRuns: RUNS }
    )
  })

  test('counts the whole authorization for a prescription never filled', () => {
    fc.assert(
      fc.property(prescriptionArbitrary, (prescription) => {
        expect(Prescription.repeatsRemainingOf({ ...prescription, fillDays: [] })).toBe(
          prescription.repeatsAllowed
        )
      }),
      { numRuns: RUNS }
    )
  })
})

describe('Prescription.statusOf', () => {
  test('property: stopped exactly when ended; otherwise completed once repeats and supply are both spent', () => {
    fc.assert(
      fc.property(prescriptionArbitrary, (prescription) => {
        const status = Prescription.statusOf(prescription)
        const lastFillDay = prescription.fillDays.at(-1) ?? 0
        const spent =
          Prescription.repeatsRemainingOf(prescription) === 0 &&
          lastFillDay + prescription.supplyDaysPerFill <= 0
        if (prescription.ended !== null) expect(status).toBe('stopped')
        else expect(status).toBe(spent ? 'completed' : 'active')
      }),
      { numRuns: RUNS }
    )
  })
})

describe('Prescription.quantityPerFillOf and dailyDoseOf', () => {
  test('property: the fill spread over its supply days is the daily dose', () => {
    fc.assert(
      fc.property(prescriptionArbitrary, (prescription) => {
        const dailyDose = Prescription.dailyDoseOf(prescription)
        expect(
          (Prescription.quantityPerFillOf(prescription) * prescription.product.strength.value) /
            prescription.supplyDaysPerFill
        ).toBeCloseTo(dailyDose.value)
        expect(dailyDose.unit).toBe(prescription.product.strength.unit)
      }),
      { numRuns: RUNS }
    )
  })
})

describe('Prescription.sigOf', () => {
  /** A hand-written tablet, to read the sig's dialect off. */
  const tablet: DrugProduct.DrugProduct = {
    din: '02000017',
    drugCode: 1,
    brandName: 'Apo-Examplazole',
    genericName: 'Examplazole',
    strength: { value: 5, unit: 'mg' },
    form: 'tablet',
    company: 'Apotex Inc',
  }

  const onceDaily = {
    key: 'rx',
    product: tablet,
    dosing: { tabletsPerDose: 1, dosesPerDay: 1, direction: null },
    supplyDaysPerFill: 30,
    repeatsAllowed: 5,
    prescriber: { key: 'doctor', display: 'DR A DOCTOR' },
    written: { day: -30, reason: 'start' },
    ended: null,
    fillDays: [-30],
  } satisfies Prescription.Prescription

  test('writes the dialect the capture shows for one tablet once daily', () => {
    expect(Prescription.sigOf(onceDaily)).toBe('TAKE 1 TABLET (=5MG) BY MOUTH ONCE DAILY')
  })

  test('multiplies the per-dose strength and pluralizes tablets, then appends the direction', () => {
    expect(
      Prescription.sigOf({
        ...onceDaily,
        product: { ...tablet, strength: { value: 500, unit: 'mg' } },
        dosing: { tabletsPerDose: 2, dosesPerDay: 2, direction: 'WITH MEALS' },
      })
    ).toBe('TAKE 2 TABLETS (=1000MG) BY MOUTH TWICE DAILY WITH MEALS')
  })

  test('property: names the tablets per dose, the dose, the frequency and the direction', () => {
    fc.assert(
      fc.property(prescriptionArbitrary, (prescription) => {
        expect(Prescription.sigOf(prescription)).toBe(
          expectedSigOf(prescription.dosing, prescription.product.strength)
        )
      }),
      { numRuns: RUNS }
    )
  })
})
