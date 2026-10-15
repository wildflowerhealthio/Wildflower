import type { UrlMatcher } from '@wildflowerhealthio/http-extraction-fundamentals'
import { Option } from 'effect'

/**
 * The Shoppers Drug Mart "mypharmacy" portal's API URLs: the three XHRs the
 * response kinds claim.
 *
 * @remarks
 * The response kinds build their matchers from {@link SHOPPERS_API_BASE_URL},
 * through {@link portalGetMatcher}, so a URL built here is one exactly one kind
 * recognizes; `portal-url.test.ts` pins that.
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

/**
 * A matcher for one portal XHR: a request for a URL `url` matches unless its
 * method is known and is not `GET`, yielding {@link SHOPPERS_API_BASE_URL},
 * the base every portal XHR is served under, as its root.
 *
 * @remarks
 * The portal only reads these URLs, so another verb at the same URL (a
 * profile update to the customers URL, say) is not the response a kind
 * parses. A request whose method the archive dropped is still claimed: the
 * Recorder writes every exchange's method as `UNKNOWN`, and refusing those
 * would refuse every Recorder capture of the portal.
 */
const portalGetMatcher =
  (url: RegExp): UrlMatcher =>
  (candidateUrl, method) =>
    url.test(candidateUrl) &&
    Option.match(method, { onNone: () => true, onSome: (verb) => verb === 'GET' })
      ? Option.some(SHOPPERS_API_BASE_URL)
      : Option.none()

export {
  SHOPPERS_API_BASE_URL,
  SHOPPERS_PORTAL_ORIGIN,
  customerUrlOf,
  portalGetMatcher,
  prescriptionHistoryUrlOf,
  prescriptionStatusUrlOf,
}
