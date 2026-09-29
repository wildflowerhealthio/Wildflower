import * as DrugProduct from '../drug-product.ts'
import type { LabDraw } from '../lab-draw.ts'
import * as Prescription from '../prescription.ts'
import type { RexallAccount } from '../rexall/rexall-account.ts'
import type { StoryDay } from '../story-day.ts'
import type { Story } from '../story.ts'
import { warren } from './people.ts'

/**
 * Warren Ashford's story, 78, Tyra's father: atrial fibrillation on warfarin
 * and type 2 diabetes on metformin, filled at Rexall.
 *
 * @remarks
 * Day numbers are relative to the as-of date (see `StoryDay`).
 *
 * **Warfarin.** Started at 5 mg daily (day −480). INR climbs to 3.8 (−385) and
 * the dose is cut to 4 mg (−384); INR settles at 2.6. The 4 mg prescription runs
 * out of repeats and is renewed (−201). A cough brings a 7-day clarithromycin
 * course (−101) — an interaction the checker should catch — and INR reaches
 * 4.1 (−95): warfarin is held for four days and resumed at 4 mg (−91) on a new
 * prescription, and INR recovers.
 *
 * **Metformin.** 500 mg twice daily (−510); HbA1c 8.4 (−300) moves it to
 * 1000 mg twice daily — two 500 mg tablets — (−296), and HbA1c falls to 7.0.
 * At the most recent refill the pharmacy switches generics from Teva to Sandoz
 * (−23), same dose.
 *
 * Refills are on a 30-day (warfarin) and 90-day (metformin) cadence, a few of
 * them picked up a day or several late.
 */

/** Warren's family physician, who writes his chronic prescriptions. */
const familyPhysician: Prescription.Prescriber = { key: 'okafor', display: 'DR N OKAFOR' }

/** The walk-in clinic physician who treats the cough. */
const walkInPhysician: Prescription.Prescriber = { key: 'tremblay', display: 'DR M TREMBLAY' }

const onceDaily: Prescription.Dosing = { tabletsPerDose: 1, dosesPerDay: 1, direction: null }

const warfarin5mg: Prescription.Prescription = {
  key: 'warfarin-1',
  product: DrugProduct.catalogue.taroWarfarin5mg,
  dosing: onceDaily,
  supplyDaysPerFill: 30,
  repeatsAllowed: 5,
  prescriber: familyPhysician,
  written: { day: -480, reason: 'start' },
  ended: { day: -384, reason: 'dose-change' },
  fillDays: Prescription.fillDaysOnCadence(-480, 30, [0, 2, 1]),
}

const warfarin4mg: Prescription.Prescription = {
  key: 'warfarin-2',
  product: DrugProduct.catalogue.taroWarfarin4mg,
  dosing: onceDaily,
  supplyDaysPerFill: 30,
  repeatsAllowed: 5,
  prescriber: familyPhysician,
  written: { day: -384, reason: 'dose-change' },
  ended: null,
  fillDays: Prescription.fillDaysOnCadence(-384, 30, [0, 1, 0, 3, 0]),
}

const warfarin4mgRenewed: Prescription.Prescription = {
  ...warfarin4mg,
  key: 'warfarin-3',
  written: { day: -201, reason: 'renewal' },
  ended: { day: -95, reason: 'hold' },
  fillDays: Prescription.fillDaysOnCadence(-201, 30, [0, 2, 0]),
}

const clarithromycin: Prescription.Prescription = {
  key: 'clarithromycin-1',
  product: DrugProduct.catalogue.apoClarithromycin500mg,
  dosing: { tabletsPerDose: 1, dosesPerDay: 2, direction: 'FOR 7 DAYS' },
  supplyDaysPerFill: 7,
  repeatsAllowed: 0,
  prescriber: walkInPhysician,
  written: { day: -101, reason: 'start' },
  ended: null,
  fillDays: [-101],
}

/** Resumed after the hold; first filled when the tablets left from the last 4 mg fill run out. */
const warfarin4mgResumed: Prescription.Prescription = {
  ...warfarin4mg,
  key: 'warfarin-4',
  written: { day: -91, reason: 'resume' },
  ended: null,
  fillDays: Prescription.fillDaysOnCadence(-77, 30, [0, 1]),
}

const withMeals = 'WITH MEALS'

const metformin500mg: Prescription.Prescription = {
  key: 'metformin-1',
  product: DrugProduct.catalogue.tevaMetformin500mg,
  dosing: { tabletsPerDose: 1, dosesPerDay: 2, direction: withMeals },
  supplyDaysPerFill: 90,
  repeatsAllowed: 3,
  prescriber: familyPhysician,
  written: { day: -510, reason: 'start' },
  ended: { day: -296, reason: 'dose-change' },
  fillDays: Prescription.fillDaysOnCadence(-510, 90, [4, 2]),
}

const metformin1000mg: Prescription.Prescription = {
  key: 'metformin-2',
  product: DrugProduct.catalogue.tevaMetformin500mg,
  dosing: { tabletsPerDose: 2, dosesPerDay: 2, direction: withMeals },
  supplyDaysPerFill: 90,
  repeatsAllowed: 3,
  prescriber: familyPhysician,
  written: { day: -296, reason: 'dose-change' },
  ended: { day: -23, reason: 'generic-switch' },
  fillDays: Prescription.fillDaysOnCadence(-296, 90, [0, 3]),
}

const metformin1000mgSandoz: Prescription.Prescription = {
  ...metformin1000mg,
  key: 'metformin-3',
  product: DrugProduct.catalogue.sandozMetformin500mg,
  repeatsAllowed: 1,
  written: { day: -23, reason: 'generic-switch' },
  ended: null,
  fillDays: [-23],
}

/** INR (unitless) and HbA1c (%) results the dose changes answer to. */
const inr = (day: StoryDay, value: number): LabDraw => ({ day, test: 'INR', value, unit: null })
const hba1c = (day: StoryDay, value: number): LabDraw => ({
  day,
  test: 'Hemoglobin A1c',
  value,
  unit: '%',
})

/** Warren's story: see the module summary. */
const warrenStory: Story = {
  person: warren,
  prescriptions: [
    metformin500mg,
    warfarin5mg,
    warfarin4mg,
    metformin1000mg,
    warfarin4mgRenewed,
    clarithromycin,
    warfarin4mgResumed,
    metformin1000mgSandoz,
  ],
  labDraws: [
    inr(-466, 2.3),
    inr(-438, 2.8),
    inr(-385, 3.8),
    inr(-370, 3.1),
    inr(-356, 2.6),
    hba1c(-300, 8.4),
    inr(-300, 2.5),
    hba1c(-210, 7.6),
    inr(-200, 2.7),
    hba1c(-120, 7.0),
    inr(-120, 2.6),
    inr(-95, 4.1),
    inr(-88, 2.9),
    inr(-60, 2.5),
    inr(-30, 2.6),
  ],
}

/** Warren's Rexall Be Well account, at a fictional store. */
const warrenRexallAccount: RexallAccount = {
  uid: '3d9f6b2e-8c41-4a57-b0e2-71c5a9d4f816',
  reportingGuid: '0b7e4c9a-52d3-4f1e-9a86-c2d4e1f07b35',
  storeId: '7128',
  pharmacyLocationId: 'pharmacy-7128',
  createdDay: -1460,
  updatedDay: -540,
}

export { warrenRexallAccount, warrenStory }
