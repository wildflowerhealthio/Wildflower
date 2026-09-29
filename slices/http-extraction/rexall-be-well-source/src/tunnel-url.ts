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
 * @param ids.profileUid - The profile's `identifiers.uid`; the searchset's
 *   `subject` is `Patient/<profileUid>`
 * @param ids.pharmacyLocationId - Carebook's id for the account's pharmacy
 *   location, the `medication-processor` the medications reference
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

export {
  REXALL_PHARMACY_LOCATION_URL,
  REXALL_PROFILE_URL,
  REXALL_STU3_BASE_URL,
  medicationListUrlOf,
}
