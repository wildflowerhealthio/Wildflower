import type { DateTime } from 'effect'

import * as Prescription from '../prescription.ts'
import type { StoryDay } from '../story-day.ts'
import type { ShoppersAccount } from './shoppers-account.ts'
import {
  chemicalNameOf,
  portalDateTimeOf,
  type ShoppersFill,
  type ShoppersPrescription,
} from './shoppers-prescription.ts'

/**
 * The body of `…/api/v1/prescriptions/<id>/prescription-status`, one per
 * prescription, in the shape `shoppers-drugmart-source`'s
 * `PrescriptionResponseKind` reads (see its `prescription-response-kind.test.ts`
 * fixture).
 *
 * @remarks
 * `prescriptionNumber`, `previousPrescription`, `numFillsLeft` and
 * `refillQuantity` are JSON numbers; `din` is the eight-digit string; the sig
 * rides `direction`. The product named is the one on the label now — the most
 * recent fill's — and `dispenses[]` holds that fill alone, as the status
 * endpoint does; every fill is in the history feed.
 */

/** Days a prescription stays valid from the day it is written, as Ontario pharmacies apply. */
const PRESCRIPTION_VALID_DAYS = 365

/** The portal's `status` block: a machine `type` and the labels the dashboard prints. */
interface PortalStatus {
  readonly label: string
  readonly portalLabel: string
  readonly labelDescription: string
  readonly type: string
}

/** One `dispenses[]` entry. */
interface StatusDispense {
  readonly dispenseId: string
  readonly quantityDispensed: number
  readonly status: 'COMPLETE'
  readonly dispenseDate: string
}

/** The whole prescription-status body. */
interface PrescriptionStatusPayload {
  readonly id: string
  readonly storeId: number
  readonly patientId: string
  readonly prescriptionNumber: number
  readonly brandName: string
  readonly chemicalName: string
  readonly numFillsLeft: number
  readonly prescriberName: string
  readonly status: PortalStatus
  readonly din: string
  readonly direction: string
  readonly refillQuantity: number
  readonly expiryDate: string
  readonly lastFillDate?: string
  readonly nextFillDate?: string
  readonly expired: boolean
  readonly archived: boolean
  readonly renewable: boolean
  readonly previousPrescription?: number
  readonly dispenses: readonly StatusDispense[]
}

/**
 * The dashboard's status for a prescription that is no longer in use: the
 * machine type and labels the capture shows.
 */
const ARCHIVED_STATUS: PortalStatus = {
  label: 'Unable to renew online',
  portalLabel: 'Unable to renew online',
  labelDescription: 'Contact your Pharmacy Team for more details',
  type: 'UNABLE_TO_RENEW_ONLINE',
}

/** A prescription with repeats left. The set is open; this type extrapolates the capture's. */
const REFILLABLE_STATUS: PortalStatus = {
  label: 'Ready for refill',
  portalLabel: 'Ready for refill',
  labelDescription: 'Request a refill and we will let you know when it is ready',
  type: 'READY_FOR_REFILL',
}

/** A prescription whose repeats have run out, still in use. */
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

const portalStatusOf = (shoppersPrescription: ShoppersPrescription): PortalStatus => {
  if (isArchived(shoppersPrescription)) return ARCHIVED_STATUS
  return Prescription.repeatsRemainingOf(shoppersPrescription.prescription) > 0
    ? REFILLABLE_STATUS
    : RENEWABLE_STATUS
}

/** The day a prescription's next fill falls due, while it is in use and has a repeat left. */
const nextFillDayOf = (shoppersPrescription: ShoppersPrescription): StoryDay | null => {
  const { prescription } = shoppersPrescription
  if (isArchived(shoppersPrescription) || Prescription.repeatsRemainingOf(prescription) === 0) {
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
): PrescriptionStatusPayload => {
  const { prescription, previousPrescriptionNumber } = shoppersPrescription
  const product = Prescription.currentProductOf(prescription)
  const lastFill = shoppersPrescription.fills.at(-1)
  const nextFillDay = nextFillDayOf(shoppersPrescription)
  const expiryDay = prescription.written.day + PRESCRIPTION_VALID_DAYS
  const expired = expiryDay <= 0
  const archived = isArchived(shoppersPrescription)
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
    expiryDate: portalDateTimeOf(asOf, expiryDay),
    ...(lastFill === undefined ? {} : { lastFillDate: portalDateTimeOf(asOf, lastFill.day) }),
    ...(nextFillDay === null ? {} : { nextFillDate: portalDateTimeOf(asOf, nextFillDay) }),
    expired,
    archived,
    renewable: !archived && !expired,
    ...(previousPrescriptionNumber === null
      ? {}
      : { previousPrescription: previousPrescriptionNumber }),
    dispenses: lastFill === undefined ? [] : [statusDispenseOf(asOf, prescription, lastFill)],
  }
}

export { prescriptionStatusPayloadOf }
export type { PortalStatus, PrescriptionStatusPayload, StatusDispense }
