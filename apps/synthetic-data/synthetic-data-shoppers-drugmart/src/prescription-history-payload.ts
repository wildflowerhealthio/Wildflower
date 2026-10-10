import type {
  HistoryPayload,
  SourceHistoryDispense,
} from '@wildflowerhealthio/shoppers-drugmart-source'
import { Prescription, StoryDay } from '@wildflowerhealthio/synthetic-data-fundamentals/story'
import type { DateTime } from 'effect'

import type { ShoppersAccount, ShoppersAddress } from './shoppers-account.ts'
import { chemicalNameOf, type ShoppersPrescription } from './shoppers-prescription.ts'

/**
 * The body of `…/api/v1/prescription-history?customerId=<pcid>`: every fill
 * across the account's prescriptions, newest first, written as
 * `shoppers-drugmart-source`'s {@link HistoryPayload} and
 * {@link SourceHistoryDispense} encode it (see its
 * `prescription-history-response-kind.test.ts` fixture).
 *
 * @remarks
 * Each entry names the product dispensed on that fill. Dates are calendar
 * dates (`2026-01-10`), as the capture writes them here. The body names no
 * patient; the importer links each entry to its prescription through
 * `prescriptionId`. The entry's `prescriberName` and `isArchive`, and the
 * store's phone number, type and address, are the capture's; the source does
 * not read them.
 */

/** The dispensing store, as each entry carries it. */
type HistoryStore = NonNullable<(typeof SourceHistoryDispense.Encoded)['store']> & {
  readonly id: number
  readonly storeName: string
  readonly phoneNumber: string
  readonly storeType: 'Pharmacy'
  readonly address: ShoppersAddress
}

/** One `dispenses[]` entry. */
type HistoryDispense = typeof SourceHistoryDispense.Encoded & {
  readonly prescriberName: string
  readonly isArchive: false
  readonly store: HistoryStore
}

/** The whole history body. */
type PrescriptionHistoryBody = typeof HistoryPayload.Encoded & {
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
): PrescriptionHistoryBody => {
  const store: HistoryStore = { ...account.store, storeType: 'Pharmacy' }
  const dispensesInStoryOrder = shoppersPrescriptions.flatMap(
    ({ prescription, prescriptionId, prescriptionNumber, fills }) =>
      fills.map((fill) => ({
        day: fill.day,
        dispense: {
          prescriptionId,
          dispenseId: fill.dispenseId,
          prescriptionNumber,
          dispenseDate: StoryDay.toIsoDate(asOf, fill.day),
          chemicalName: chemicalNameOf(prescription.product),
          brandName: prescription.product.brandName,
          quantityDispensed: Prescription.quantityPerFillOf(prescription),
          prescriberName: prescription.prescriber.display,
          din: prescription.product.din,
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
