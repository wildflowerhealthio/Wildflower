import * as Seeding from '@wildflowerhealthio/synthetic-data-fundamentals/seeding'
import {
  type DrugProduct,
  type Prescription,
  StoryDay,
} from '@wildflowerhealthio/synthetic-data-fundamentals/story'
import type { DateTime } from 'effect'

import type { ShoppersAccount, ShoppersPatient } from './shoppers-account.ts'

/**
 * A story's prescriptions with the ids, numbers and links the Shoppers portal
 * keys them by, and the dates as the portal writes them — shared by the
 * prescription-status and prescription-history bodies, so both feeds name a
 * prescription and its fills alike.
 */

/** One fill: a dispense the history feed lists, and the status feed its latest. */
interface ShoppersFill {
  readonly dispenseId: string
  readonly day: StoryDay.StoryDay
}

/**
 * A prescription as the portal keys it: its uuid `id` and human-facing
 * `prescriptionNumber` hashed from the account, the patient and the
 * prescription's key, and the number of the prescription it continues.
 */
interface ShoppersPrescription {
  readonly prescription: Prescription.Prescription
  readonly patient: ShoppersPatient
  readonly prescriptionId: string
  /** Seven digits, a JSON number on the wire. */
  readonly prescriptionNumber: number
  /**
   * The `prescriptionNumber` of the one it continues — the previous
   * prescription for the same drug in the patient's story — or `null` for the
   * first.
   */
  readonly previousPrescriptionNumber: number | null
  /**
   * Whether a later prescription for the same drug continues it (a new dose, a
   * renewal): the portal files it as archived.
   */
  readonly superseded: boolean
  /** In the order they were filled. */
  readonly fills: readonly ShoppersFill[]
}

/** The keys every id of `prescription` under `patient` is hashed from. */
const prescriptionKeysOf = (
  account: ShoppersAccount,
  patient: ShoppersPatient,
  prescription: Prescription.Prescription
): readonly string[] => ['shoppers', account.pcid, patient.patientId, prescription.key]

const prescriptionNumberOf = (keys: readonly string[]): number =>
  Seeding.integerOf([...keys, 'prescription-number'], 1_000_000, 9_999_999)

/** Whether two prescriptions are for the same drug: one medication episode. */
const isSameDrug = (left: Prescription.Prescription, right: Prescription.Prescription): boolean =>
  left.product.genericName === right.product.genericName

/**
 * Every prescription of every patient on `account`, keyed — in the order the
 * patients are listed, and each patient's in the order they were written.
 */
const shoppersPrescriptionsOf = (account: ShoppersAccount): readonly ShoppersPrescription[] =>
  account.patients.flatMap((patient) =>
    patient.story.prescriptions.map((prescription, index, prescriptions) => {
      const keys = prescriptionKeysOf(account, patient, prescription)
      const previous = prescriptions
        .slice(0, index)
        .findLast((earlier) => isSameDrug(earlier, prescription))
      return {
        prescription,
        patient,
        prescriptionId: Seeding.uuidOf(keys),
        prescriptionNumber: prescriptionNumberOf(keys),
        previousPrescriptionNumber:
          previous === undefined
            ? null
            : prescriptionNumberOf(prescriptionKeysOf(account, patient, previous)),
        superseded: prescriptions.slice(index + 1).some((later) => isSameDrug(later, prescription)),
        fills: prescription.fillDays.map((day, fillIndex) => ({
          dispenseId: Seeding.uuidOf([...keys, 'fill', String(fillIndex + 1)]),
          day,
        })),
      }
    })
  )

/** A drug's name and strength as the portal's `chemicalName` prints it: `'Levothyroxine 75mcg'`. */
const chemicalNameOf = (product: DrugProduct.DrugProduct): string =>
  `${product.genericName} ${product.strength.value}${product.strength.unit}`

/** A story day as the status feed writes its dates: midnight UTC, `2026-01-10T00:00:00Z`. */
const portalDateTimeOf = (asOf: DateTime.Utc, storyDay: StoryDay.StoryDay): string =>
  `${StoryDay.toIsoDate(asOf, storyDay)}T00:00:00Z`

export { chemicalNameOf, portalDateTimeOf, shoppersPrescriptionsOf }
export type { ShoppersFill, ShoppersPrescription }
