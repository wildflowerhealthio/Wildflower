import type { UrlMatcher } from '@wildflowerhealthio/http-extraction-fundamentals'
import { Option } from 'effect'

/**
 * The Rexall tunnel's URLs: the host the portal's single-page app fetches the
 * carebook profile and the carebook STU3 API from.
 *
 * @remarks
 * The response kinds build their matchers from these, so a URL built here is
 * one a kind recognizes; `tunnel-url.test.ts` pins that.
 */

/** The tunnel host every carebook XHR goes to. */
const REXALL_TUNNEL_ORIGIN = 'https://rexall-prd-tunnel.letsbewell.ca'

/** The profile-identity XHR `ProfileResponseKind` recognizes. */
const REXALL_PROFILE_URL = `${REXALL_TUNNEL_ORIGIN}/enduser/profile/v2/me`

/** The carebook STU3 API's base: every searchset `fullUrl` is rooted here. */
const REXALL_STU3_BASE_URL = `${REXALL_TUNNEL_ORIGIN}/enduser/health/v1/fhir/stu3`

/**
 * The pharmacy `Location` search the prescriptions page runs, without its
 * query. `MedicationListResponseKind` recognizes it followed by a query.
 */
const REXALL_PHARMACY_LOCATION_URL = `${REXALL_STU3_BASE_URL}/pharmacy/Location`

/** The resource types the prescriptions page `_revinclude`s, in the order it sends them. */
const REVINCLUDED_RESOURCE_TYPES = [
  'MedicationRequest',
  'MedicationDispense',
  'DocumentReference',
  'Immunization',
] as const

/**
 * The prescriptions-page searchset URL for one account, with the query the
 * portal sends: the patient, the pharmacy location, `lastActiveOnly`, each
 * `_revinclude` on `extension.medicationrecord-processor`, and the portal's
 * `_count`.
 *
 * @param ids - The account's ids:
 *   - `profileUid` — the profile's `identifiers.uid`; the searchset's
 *     `subject` is `Patient/<profileUid>`
 *   - `pharmacyLocationId` — Carebook's id for the account's pharmacy
 *     location, the `medication-processor` the medications reference
 */
const medicationListUrlOf = ({
  profileUid,
  pharmacyLocationId,
}: {
  readonly profileUid: string
  readonly pharmacyLocationId: string
}): string =>
  `${REXALL_PHARMACY_LOCATION_URL}?subject=Patient/${encodeURIComponent(profileUid)}` +
  `&_id=${encodeURIComponent(pharmacyLocationId)}` +
  '&_query=lastActiveOnly' +
  REVINCLUDED_RESOURCE_TYPES.map(
    (resourceType) => `&_revinclude=${resourceType}:extension.medicationrecord-processor`
  ).join('') +
  '&_count=2147483646'

/**
 * A matcher for one tunnel XHR: a URL `url` matches unless the request is a
 * known verb other than `GET`, yielding the tunnel origin as its root.
 *
 * @remarks
 * The portal only reads the tunnel, so any other verb at the same URL is not
 * the response a kind parses: a CORS preflight `OPTIONS` (the SPA's origin is
 * not the tunnel's) carries no body to decode. A request whose method the
 * archive dropped is still claimed: the Recorder observes the response side
 * only and writes every method as `UNKNOWN`, so refusing it would refuse every
 * Recorder capture of the portal.
 */
const tunnelGetMatcher =
  (url: RegExp): UrlMatcher =>
  (candidateUrl, method) =>
    url.test(candidateUrl) && Option.getOrElse(method, () => 'GET') === 'GET'
      ? Option.some(REXALL_TUNNEL_ORIGIN)
      : Option.none()

export {
  REXALL_PHARMACY_LOCATION_URL,
  REXALL_PROFILE_URL,
  REXALL_STU3_BASE_URL,
  medicationListUrlOf,
  tunnelGetMatcher,
}
