import type { DateTime } from 'effect'

import * as Prescription from '../prescription.ts'
import * as StoryDay from '../story-day.ts'
import type { ShoppersAccount, ShoppersAddress } from './shoppers-account.ts'
import { chemicalNameOf, type ShoppersPrescription } from './shoppers-prescription.ts'

/**
 * The body of `…/api/v1/prescription-history?customerId=<pcid>`: every fill
 * across the account's prescriptions, newest first, in the shape
 * `shoppers-drugmart-source`'s `PrescriptionHistoryResponseKind` reads (see
 * its `prescription-history-response-kind.test.ts` fixture).
 *
 * @remarks
 * Unlike the status feed, each entry names the product dispensed **on that
 * fill** — its own `din`, `brandName` and `chemicalName` — so a generic
 * interchange shows as a DIN change between two fills of one prescription.
 * Dates are calendar dates (`2026-01-10`), as the capture writes them here. The
 * payload names no patient; the importer links each entry to its prescription
 * through `prescriptionId`.
 */

/** The dispensing store, as each entry carries it. */
interface HistoryStore {
  readonly id: number
  readonly storeName: string
  readonly phoneNumber: string
  readonly storeType: 'Pharmacy'
  readonly address: ShoppersAddress
}

/** One `dispenses[]` entry. */
interface HistoryDispense {
  readonly prescriptionId: string
  readonly dispenseId: string
  readonly prescriptionNumber: number
  readonly dispenseDate: string
  readonly chemicalName: string
  readonly brandName: string
  readonly quantityDispensed: number
  readonly prescriberName: string
  readonly din: string
  readonly isArchive: false
  readonly store: HistoryStore
}

/** The whole history body. */
interface PrescriptionHistoryPayload {
  readonly dispenses: readonly HistoryDispense[]
}

/**
 * The history body for `account`'s prescriptions.
 *
 * @param asOf - The as-of instant the story's days are dated from
 * @param shoppersPrescriptions - Every prescription on the account
 *   (`shoppersPrescriptionsOf`)
 */
const prescriptionHistoryPayloadOf = (
  asOf: DateTime.Utc,
  account: ShoppersAccount,
  shoppersPrescriptions: readonly ShoppersPrescription[]
): PrescriptionHistoryPayload => {
  const store: HistoryStore = { ...account.store, storeType: 'Pharmacy' }
  const dispensesInStoryOrder = shoppersPrescriptions.flatMap((shoppersPrescription) =>
    shoppersPrescription.fills.map((fill) => ({
      day: fill.day,
      dispense: {
        prescriptionId: shoppersPrescription.prescriptionId,
        dispenseId: fill.dispenseId,
        prescriptionNumber: shoppersPrescription.prescriptionNumber,
        dispenseDate: StoryDay.toIsoDate(asOf, fill.day),
        chemicalName: chemicalNameOf(fill.product),
        brandName: fill.product.brandName,
        quantityDispensed: Prescription.quantityPerFillOf(shoppersPrescription.prescription),
        prescriberName: shoppersPrescription.prescription.prescriber.display,
        din: fill.product.din,
        isArchive: false,
        store,
      } satisfies HistoryDispense,
    }))
  )
  return {
    dispenses: dispensesInStoryOrder
      .toSorted((left, right) => right.day - left.day)
      .map(({ dispense }) => dispense),
  }
}

export { prescriptionHistoryPayloadOf }
export type { HistoryDispense, HistoryStore, PrescriptionHistoryPayload }
