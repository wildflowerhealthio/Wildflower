import type { DateTime } from 'effect'
import type { SourceDispense, SourcePrescription } from 'shoppers-drugmart-source'
import { Prescription, type StoryDay } from 'synthetic-data-fundamentals/story'

import type { ShoppersAccount } from './shoppers-account.ts'
import {
  chemicalNameOf,
  portalDateTimeOf,
  type ShoppersFill,
  type ShoppersPrescription,
} from './shoppers-prescription.ts'

/**
 * The body of `…/api/v1/prescriptions/<id>/prescription-status`, one per
 * prescription, written as `shoppers-drugmart-source`'s
 * {@link SourcePrescription} encodes it (see its
 * `prescription-response-kind.test.ts` fixture).
 *
 * @remarks
 * `prescriptionNumber`, `previousPrescription`, `numFillsLeft` and
 * `refillQuantity` are JSON numbers; `din` is the eight-digit string; the sig
 * rides `direction`. `dispenses[]` holds the most recent fill alone, as the
 * status endpoint does; every fill is in the history feed.
 */

/** The portal's `status` block: a machine `type` and the labels the dashboard prints. */
type PortalStatus = Required<NonNullable<(typeof SourcePrescription.Encoded)['status']>>

/** One `dispenses[]` entry. */
type StatusDispense = typeof SourceDispense.Encoded

/** The whole prescription-status body. */
type PrescriptionStatusBody = typeof SourcePrescription.Encoded & {
  readonly dispenses: readonly StatusDispense[]
}

/** Days a prescription stays valid from the day it is written, as Ontario pharmacies apply. */
const PRESCRIPTION_VALID_DAYS = 365

/**
 * The dashboard's status for a prescription that can no longer be filled —
 * archived or expired: the machine type and labels the capture shows.
 */
const UNABLE_TO_RENEW_STATUS: PortalStatus = {
  label: 'Unable to renew online',
  portalLabel: 'Unable to renew online',
  labelDescription: 'Contact your Pharmacy Team for more details',
  type: 'UNABLE_TO_RENEW_ONLINE',
}

/** A valid prescription with repeats left. The set is open; this type extrapolates the capture's. */
const REFILLABLE_STATUS: PortalStatus = {
  label: 'Ready for refill',
  portalLabel: 'Ready for refill',
  labelDescription: 'Request a refill and we will let you know when it is ready',
  type: 'READY_FOR_REFILL',
}

/** A valid prescription whose repeats have run out, still in use. */
const RENEWABLE_STATUS: PortalStatus = {
  label: 'Ready for renewal',
  portalLabel: 'Ready to renew',
  labelDescription: 'Request a renewal and we will contact your prescriber',
  type: 'READY_FOR_RENEW',
}

/**
 * Whether the portal files the prescription as archived: it was stopped, or a
 * later prescription for the same drug continues it.
 */
const isArchived = ({ prescription, superseded }: ShoppersPrescription): boolean =>
  prescription.ended !== null || superseded

/** The last day before the prescription's validity runs out, as a story day. */
const expiryDayOf = ({ prescription }: ShoppersPrescription): StoryDay.StoryDay =>
  prescription.written.day + PRESCRIPTION_VALID_DAYS

/** Whether the prescription has expired by the as-of day. */
const isExpired = (shoppersPrescription: ShoppersPrescription): boolean =>
  expiryDayOf(shoppersPrescription) <= 0

/** Whether the prescription can still be filled: neither archived nor expired. */
const isFillable = (shoppersPrescription: ShoppersPrescription): boolean =>
  !isArchived(shoppersPrescription) && !isExpired(shoppersPrescription)

const portalStatusOf = (shoppersPrescription: ShoppersPrescription): PortalStatus => {
  if (!isFillable(shoppersPrescription)) return UNABLE_TO_RENEW_STATUS
  return Prescription.repeatsRemainingOf(shoppersPrescription.prescription) > 0
    ? REFILLABLE_STATUS
    : RENEWABLE_STATUS
}

/** The day a prescription's next fill falls due, while it can be filled and has a repeat left. */
const nextFillDayOf = (shoppersPrescription: ShoppersPrescription): StoryDay.StoryDay | null => {
  const { prescription } = shoppersPrescription
  if (!isFillable(shoppersPrescription) || Prescription.repeatsRemainingOf(prescription) === 0) {
    return null
  }
  return Prescription.suppliedUntilOf(prescription)
}

const statusDispenseOf = (
  asOf: DateTime.Utc,
  prescription: Prescription.Prescription,
  fill: ShoppersFill
): StatusDispense => ({
  dispenseId: fill.dispenseId,
  quantityDispensed: Prescription.quantityPerFillOf(prescription),
  status: 'COMPLETE',
  dispenseDate: portalDateTimeOf(asOf, fill.day),
})

/**
 * The prescription-status body for one prescription on `account`.
 *
 * @param asOf - The as-of instant the story's days are dated from
 */
const prescriptionStatusPayloadOf = (
  asOf: DateTime.Utc,
  account: ShoppersAccount,
  shoppersPrescription: ShoppersPrescription
): PrescriptionStatusBody => {
  const { prescription, previousPrescriptionNumber } = shoppersPrescription
  const { product } = prescription
  const lastFill = shoppersPrescription.fills.at(-1)
  const nextFillDay = nextFillDayOf(shoppersPrescription)
  return {
    id: shoppersPrescription.prescriptionId,
    storeId: account.store.id,
    patientId: shoppersPrescription.patient.patientId,
    prescriptionNumber: shoppersPrescription.prescriptionNumber,
    brandName: product.brandName,
    chemicalName: chemicalNameOf(product),
    numFillsLeft: Prescription.repeatsRemainingOf(prescription),
    prescriberName: prescription.prescriber.display,
    status: portalStatusOf(shoppersPrescription),
    din: product.din,
    direction: Prescription.sigOf(prescription),
    refillQuantity: Prescription.quantityPerFillOf(prescription),
    expiryDate: portalDateTimeOf(asOf, expiryDayOf(shoppersPrescription)),
    ...(lastFill === undefined ? {} : { lastFillDate: portalDateTimeOf(asOf, lastFill.day) }),
    ...(nextFillDay === null ? {} : { nextFillDate: portalDateTimeOf(asOf, nextFillDay) }),
    expired: isExpired(shoppersPrescription),
    archived: isArchived(shoppersPrescription),
    renewable: isFillable(shoppersPrescription),
    ...(previousPrescriptionNumber === null
      ? {}
      : { previousPrescription: previousPrescriptionNumber }),
    dispenses: lastFill === undefined ? [] : [statusDispenseOf(asOf, prescription, lastFill)],
  }
}

export { prescriptionStatusPayloadOf }
