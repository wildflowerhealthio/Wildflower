/**
 * The Shoppers Drug Mart "mypharmacy" portal's API URLs: the three XHRs the
 * response kinds claim.
 *
 * @remarks
 * The response kinds build their matchers from {@link SHOPPERS_API_BASE_URL},
 * so a URL built here is one exactly one kind recognizes; `portal-url.test.ts`
 * pins that.
 */

/** The portal's host: it serves the pages and the API alike. */
const SHOPPERS_PORTAL_ORIGIN = 'https://mypharmacy.shoppersdrugmart.ca'

/** The API's base: every XHR a response kind claims is under it. */
const SHOPPERS_API_BASE_URL = `${SHOPPERS_PORTAL_ORIGIN}/api/v1`

/**
 * The customers XHR for an account, without its query: `CustomerResponseKind`
 * recognizes it with or without one (the portal sends an `?expand=…` the kind
 * does not read).
 *
 * @param pcid - The account's `customer.pcid`
 */
const customerUrlOf = (pcid: string): string =>
  `${SHOPPERS_API_BASE_URL}/customers/pcid/${encodeURIComponent(pcid)}`

/**
 * One prescription's status XHR, which `PrescriptionResponseKind` recognizes.
 *
 * @param prescriptionId - The prescription's uuid (`id` in its status body)
 */
const prescriptionStatusUrlOf = (prescriptionId: string): string =>
  `${SHOPPERS_API_BASE_URL}/prescriptions/${encodeURIComponent(prescriptionId)}/prescription-status`

/**
 * An account's prescription-history XHR, which
 * `PrescriptionHistoryResponseKind` recognizes.
 *
 * @param customerId - The account's `customer.pcid`
 */
const prescriptionHistoryUrlOf = (customerId: string): string =>
  `${SHOPPERS_API_BASE_URL}/prescription-history?customerId=${encodeURIComponent(customerId)}`

export {
  SHOPPERS_API_BASE_URL,
  SHOPPERS_PORTAL_ORIGIN,
  customerUrlOf,
  prescriptionHistoryUrlOf,
  prescriptionStatusUrlOf,
}
