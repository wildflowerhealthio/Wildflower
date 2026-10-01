import type { Effect, Schema } from 'effect'
import { withMandatoryId } from 'fhir-r4/data-types'
import { ServiceRequest } from 'fhir-r4/resources'
import type Client from 'fhirclient/lib/Client'

import {
  RESOURCE_PAGE_SIZE,
  type BundleDecodeError,
  type ResourcePageRequestError,
  fetchResourcePage,
  type PagedResourceRead,
  type ResourcePage,
  type ResourcePageCursor,
} from './resource-page.ts'

/**
 * The schema every `ServiceRequest` entry decodes through: the R4 resource with
 * its `id` required, as the FHIR server always returns one. An entry without an
 * `id` fails the decode.
 */
const ServiceRequestWithIdSchema = withMandatoryId(ServiceRequest.Schema)

/** The decoded FHIR R4 `ServiceRequest` resource, `id` present. */
type ServiceRequestResource = Schema.Schema.Type<typeof ServiceRequestWithIdSchema>

/**
 * One page of a `ServiceRequest` read: the decoded resources on this page and
 * the cursor to the next page (`null` when this is the last page).
 */
type ServiceRequestPage = ResourcePage<ServiceRequestResource>

/** The first-page input for {@link fetchActiveServiceRequestPage} and {@link fetchServiceRequestPage}. */
interface ServiceRequestFirstPage {
  /**
   * The patient to scope the search to, or `null` for an unscoped search that
   * returns every matching `ServiceRequest` the session's granted scopes expose.
   */
  readonly patientId: string | null
  /** The `system|code` token the requests carry as `category`, sent as the `category` parameter. */
  readonly categoryToken: string
  /**
   * The canonical url the requests name in `instantiatesCanonical` — the
   * definition they carry out — sent as the `instantiates-canonical` parameter,
   * or `null` for every definition (to find which ones the patient follows).
   */
  readonly instantiatesCanonicalUrl: string | null
}

/**
 * The cursor {@link fetchActiveServiceRequestPage} and
 * {@link fetchServiceRequestPage} read from. `first` carries
 * the patient scope, category and definition; `{ pageUrl }` continues from a
 * previous page's `nextPageUrl`.
 */
type ServiceRequestPageCursor = ResourcePageCursor<ServiceRequestFirstPage>

// Oldest-authored first, server-side, so scroll paging can append each page
// without reordering rows already on screen (`authored` is the FHIR R4
// `ServiceRequest` search parameter backing `authoredOn`).
const SEARCH_PARAMS = `_sort=authored&_count=${RESOURCE_PAGE_SIZE}`

/**
 * The first page's search parameters: the patient scope, category and
 * definition, then `extraParams` (already URL-encoded) before the sort and
 * page size.
 */
const serviceRequestFirstPageQuery = (
  { patientId, categoryToken, instantiatesCanonicalUrl }: ServiceRequestFirstPage,
  extraParams: readonly string[]
): string => {
  const parts: string[] = []
  if (patientId !== null) parts.push(`patient=${encodeURIComponent(patientId)}`)
  parts.push(`category=${encodeURIComponent(categoryToken)}`)
  if (instantiatesCanonicalUrl !== null) {
    parts.push(`instantiates-canonical=${encodeURIComponent(instantiatesCanonicalUrl)}`)
  }
  parts.push(...extraParams, SEARCH_PARAMS)
  return parts.join('&')
}

/** The `ServiceRequest` read: the active requests of one category carrying out one definition. */
const activeServiceRequestRead: PagedResourceRead<
  ServiceRequestResource,
  Schema.Schema.Encoded<typeof ServiceRequestWithIdSchema>,
  ServiceRequestFirstPage
> = {
  resourceType: 'ServiceRequest',
  schema: ServiceRequestWithIdSchema,
  // Only requests still in force.
  firstPageQuery: (first: ServiceRequestFirstPage): string =>
    serviceRequestFirstPageQuery(first, ['status=active']),
}

/** The `ServiceRequest` read: the requests of one category carrying out one definition, in any status. */
const serviceRequestRead: PagedResourceRead<
  ServiceRequestResource,
  Schema.Schema.Encoded<typeof ServiceRequestWithIdSchema>,
  ServiceRequestFirstPage
> = {
  resourceType: 'ServiceRequest',
  schema: ServiceRequestWithIdSchema,
  firstPageQuery: (first: ServiceRequestFirstPage): string =>
    serviceRequestFirstPageQuery(first, []),
}

/**
 * Fetch a single page of the `active` `ServiceRequest`s of one category that
 * carry out one definition, and report the cursor to the next page.
 *
 * @param client - The SMART client the search is issued through
 * @param cursor - Patient scope, category and definition for the first page,
 *   or a previous page's `nextPageUrl`
 * @returns An effect yielding the page's decoded `ServiceRequest`s and the next page's cursor
 *
 * @remarks
 * Only `active` requests are read: a `revoked` or `completed` request is no
 * longer one to act on. The patient id is a parameter rather than something
 * this reader lifts off `client.patient.id`, so the caller decides what "no
 * patient in context" means for its launch; `null` drops the `patient=`
 * filter entirely. A `null` definition drops `instantiates-canonical=`, so a
 * caller can find which definitions a patient's requests carry out before it
 * knows any url. An entry without an `id` is dropped and counted like any
 * other that fails to decode.
 */
const fetchActiveServiceRequestPage = (
  client: Client,
  cursor: ServiceRequestPageCursor
): Effect.Effect<ServiceRequestPage, ResourcePageRequestError | BundleDecodeError> =>
  fetchResourcePage(client, activeServiceRequestRead, cursor)

/**
 * Fetch a single page of the `ServiceRequest`s of one category that carry out
 * one definition, in every `status`, and report the cursor to the next page.
 *
 * @param client - The SMART client the search is issued through
 * @param cursor - Patient scope, category and definition for the first page,
 *   or a previous page's `nextPageUrl`
 * @returns An effect yielding the page's decoded `ServiceRequest`s and the next page's cursor
 *
 * @remarks
 * {@link fetchActiveServiceRequestPage} without the `status=active` filter,
 * for a caller that reads closed requests too — a history judged against the
 * request each event carried out. Which statuses it uses is its own decision.
 */
const fetchServiceRequestPage = (
  client: Client,
  cursor: ServiceRequestPageCursor
): Effect.Effect<ServiceRequestPage, ResourcePageRequestError | BundleDecodeError> =>
  fetchResourcePage(client, serviceRequestRead, cursor)

export {
  fetchActiveServiceRequestPage,
  fetchServiceRequestPage,
  type ServiceRequestFirstPage,
  type ServiceRequestPage,
  type ServiceRequestPageCursor,
  type ServiceRequestResource,
}
