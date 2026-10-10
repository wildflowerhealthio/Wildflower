import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as DrugProduct from './story/drug-product.ts'
import * as Prescription from './story/prescription.ts'
import { storyCaseArbitrary } from './test-helpers.ts'

const RUNS = numRunsFor({ base: 100 })

const storyCaseArb = storyCaseArbitrary('someone')

describe('storyCaseArbitrary', () => {
  test('property: every prescription is filled, written on its own day, and dated before the as-of day', () => {
    fc.assert(
      fc.property(storyCaseArb, ({ story }) => {
        const writtenDays = story.prescriptions.map(({ written }) => written.day)
        expect(new Set(writtenDays).size).toBe(writtenDays.length)
        expect(writtenDays).toEqual(writtenDays.toSorted((left, right) => left - right))
        for (const prescription of story.prescriptions) {
          expect(prescription.fillDays.length).toBeGreaterThanOrEqual(1)
          expect(prescription.fillDays.length - 1).toBeLessThanOrEqual(prescription.repeatsAllowed)
          const days = [
            prescription.written.day,
            ...prescription.fillDays,
            ...(prescription.ended === null ? [] : [prescription.ended.day]),
          ]
          for (const day of days) expect(day).toBeLessThan(0)
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('property: a dose change changes the daily dose of the prescription it follows', () => {
    fc.assert(
      fc.property(storyCaseArb, ({ story }) => {
        const byDrug = Map.groupBy(story.prescriptions, ({ key }) => key.replace(/-\d+$/, ''))
        for (const episode of byDrug.values()) {
          for (const [index, prescription] of episode.entries()) {
            const previous = episode[index - 1]
            if (prescription.written.reason !== 'dose-change' || previous === undefined) continue
            expect(Prescription.dailyDoseOf(prescription)).not.toEqual(
              Prescription.dailyDoseOf(previous)
            )
          }
        }
      }),
      { numRuns: RUNS }
    )
  })

  test("property: previousKey and nextKey chain each generic name's prescriptions in written order", () => {
    fc.assert(
      fc.property(storyCaseArb, ({ story, expected }) => {
        const byGenericName = Map.groupBy(
          story.prescriptions.map((prescription, index) => ({
            genericName: prescription.product.genericName,
            links: expected[index],
          })),
          ({ genericName }) => genericName
        )
        for (const drug of byGenericName.values()) {
          const keys = drug.map(({ links }) => links?.key)
          expect(drug.map(({ links }) => links?.previousKey)).toEqual([null, ...keys.slice(0, -1)])
          expect(drug.map(({ links }) => links?.nextKey)).toEqual([...keys.slice(1), null])
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('property: its independent reckoning agrees with the model functions', () => {
    fc.assert(
      fc.property(storyCaseArb, ({ story, expected }) => {
        expect(expected).toHaveLength(story.prescriptions.length)
        story.prescriptions.forEach((prescription, index) => {
          expect(expected[index]).toEqual({
            key: prescription.key,
            writtenDay: prescription.written.day,
            fillDays: prescription.fillDays,
            lastFillDay: prescription.fillDays.at(-1),
            name: DrugProduct.labelOf(prescription.product),
            din: prescription.product.din,
            previousKey: expected[index]?.previousKey,
            nextKey: expected[index]?.nextKey,
            quantity: Prescription.quantityPerFillOf(prescription),
            supplyDays: prescription.supplyDaysPerFill,
            repeatsAllowed: prescription.repeatsAllowed,
            repeatsAvailable: Prescription.repeatsRemainingOf(prescription),
            status: Prescription.statusOf(prescription),
            sig: Prescription.sigOf(prescription),
            dailyDose: Prescription.dailyDoseOf(prescription),
          })
        })
      }),
      { numRuns: RUNS }
    )
  })
})
