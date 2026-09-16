import type { Schema } from 'effect'
import { Observation } from 'fhir-r4/resources'
import type Client from 'fhirclient/lib/Client'

import {
  RESOURCE_PAGE_SIZE,
  fetchResourcePage,
  type PagedResourceRead,
  type ResourcePage,
  type ResourcePageCursor,
} from './resource-page.ts'

/** The decoded FHIR R4 `Observation` resource. */
type ObservationResource = Schema.Schema.Type<typeof Observation.Schema>

/**
 * One page of an `Observation` read: the decoded resources on this page and the
 * cursor to the next page (`null` when this is the last page).
 */
type ObservationPage = ResourcePage<ObservationResource>

/**
 * The cursor {@link fetchObservationPage} reads from. `first` carries the patient
 * scope — the id the caller read off `client.patient.id`, or `null` for a
 * `system/` launch with no patient in context, which reads every patient's
 * observations.
 */
type ObservationPageCursor = ResourcePageCursor<string | null>

// Oldest-observed first, server-side, so scroll paging can append each page
// without reordering rows already on screen. `date` is the FHIR R4 `Observation`
// search parameter backing `effective[x]`.
const SORT_PARAM = `_sort=date&_count=${RESOURCE_PAGE_SIZE}`

/** The `Observation` read: patient-scoped when a patient is in context. */
const observationRead: PagedResourceRead<
  ObservationResource,
  Schema.Schema.Encoded<typeof Observation.Schema>,
  string | null
> = {
  resourceType: 'Observation',
  schema: Observation.Schema,
  firstPageQuery: (patientId: string | null): string =>
    patientId === null ? SORT_PARAM : `patient=${encodeURIComponent(patientId)}&${SORT_PARAM}`,
}

/**
 * Fetch a single page of `Observation`s from the SMART FHIR server and report
 * the cursor to the next page, so a viewer can page on demand (e.g.
 * scroll-driven loading) instead of reading a patient's whole history up front.
 *
 * @param client - The SMART client the search is issued through
 * @param cursor - Patient scope for the first page, or a previous page's `nextPageUrl`
 * @returns The page's decoded `Observation`s and the next page's cursor
 *
 * @remarks
 * The patient id is a parameter rather than something this reader lifts off
 * `client.patient.id`, so the caller decides what "no patient in context" means
 * for its launch; `null` reads every patient's observations.
 *
 * Rows a server sends without a `status` survive: `Observation.Schema` defaults a
 * missing status to FHIR's own `unknown` sentinel rather than failing the entry.
 */
const fetchObservationPage = async (
  client: Client,
  cursor: ObservationPageCursor
): Promise<ObservationPage> => fetchResourcePage(client, observationRead, cursor)

export {
  fetchObservationPage,
  type ObservationPage,
  type ObservationPageCursor,
  type ObservationResource,
}
