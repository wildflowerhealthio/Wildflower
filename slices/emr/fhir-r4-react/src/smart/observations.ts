import type { Effect, Schema } from 'effect'
import { Observation } from 'fhir-r4/resources'
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

/**
 * The first-page input for {@link fetchObservationBasedOnPage}: the patient the
 * observations are about and the request they were made against.
 */
interface ObservationBasedOnFirstPage {
  /** The patient to scope the search to — the id the caller read off `client.patient.id`. */
  readonly patientId: string
  /**
   * The literal reference the observations name in `basedOn`, e.g.
   * `CarePlan/plan-1` — sent as the `based-on` search parameter.
   */
  readonly basedOn: string
}

/**
 * The cursor {@link fetchObservationBasedOnPage} reads from. `first` carries the
 * patient and the `based-on` reference; `{ pageUrl }` continues from a previous
 * page's `nextPageUrl`.
 */
type ObservationBasedOnPageCursor = ResourcePageCursor<ObservationBasedOnFirstPage>

// The first page's non-scope search parameters: oldest-observed first,
// server-side, so scroll paging can append each page without reordering rows
// already on screen (`date` is the FHIR R4 `Observation` search parameter
// backing `effective[x]`), and a page size pinned rather than left to whatever
// default the server picks.
const SEARCH_PARAMS = `_sort=date&_count=${RESOURCE_PAGE_SIZE}`

/** The `Observation` read: patient-scoped when a patient is in context. */
const observationRead: PagedResourceRead<
  ObservationResource,
  Schema.Schema.Encoded<typeof Observation.Schema>,
  string | null
> = {
  resourceType: 'Observation',
  schema: Observation.Schema,
  firstPageQuery: (patientId: string | null): string =>
    patientId === null
      ? SEARCH_PARAMS
      : `patient=${encodeURIComponent(patientId)}&${SEARCH_PARAMS}`,
}

/** The `Observation` read narrowed to the observations made against one request. */
const observationBasedOnRead: PagedResourceRead<
  ObservationResource,
  Schema.Schema.Encoded<typeof Observation.Schema>,
  ObservationBasedOnFirstPage
> = {
  resourceType: 'Observation',
  schema: Observation.Schema,
  firstPageQuery: ({ patientId, basedOn }: ObservationBasedOnFirstPage): string =>
    `patient=${encodeURIComponent(patientId)}&based-on=${encodeURIComponent(basedOn)}&${SEARCH_PARAMS}`,
}

/**
 * Fetch a single page of `Observation`s from the SMART FHIR server and report
 * the cursor to the next page, so a viewer can page on demand (e.g.
 * scroll-driven loading) instead of reading a patient's whole history up front.
 *
 * @param client - The SMART client the search is issued through
 * @param cursor - Patient scope for the first page, or a previous page's `nextPageUrl`
 * @returns An effect yielding the page's decoded `Observation`s and the next page's cursor
 *
 * @remarks
 * The patient id is a parameter rather than something this reader lifts off
 * `client.patient.id`, so the caller decides what "no patient in context" means
 * for its launch; `null` reads every patient's observations.
 *
 * Rows a server sends without a `status` survive: `Observation.Schema` defaults a
 * missing status to FHIR's own `unknown` sentinel rather than failing the entry.
 */
const fetchObservationPage = (
  client: Client,
  cursor: ObservationPageCursor
): Effect.Effect<ObservationPage, ResourcePageRequestError | BundleDecodeError> =>
  fetchResourcePage(client, observationRead, cursor)

/**
 * Fetch a single page of one patient's `Observation`s made against one request
 * — a plan's logged sessions, say (`based-on=CarePlan/<id>`) — and report the
 * cursor to the next page.
 *
 * @param client - The SMART client the search is issued through
 * @param cursor - The patient and `based-on` reference for the first page, or a
 *   previous page's `nextPageUrl`
 * @returns An effect yielding the page's decoded `Observation`s and the next page's cursor
 *
 * @remarks
 * The sibling of {@link fetchObservationPage} with the same order (oldest
 * observed first) and page size, narrowed server-side by FHIR R4's
 * `Observation` `based-on` search parameter, so observations made against any
 * other request never reach the caller. Always patient-scoped: the `based-on`
 * narrowing is for one person's record, not a cross-patient report.
 */
const fetchObservationBasedOnPage = (
  client: Client,
  cursor: ObservationBasedOnPageCursor
): Effect.Effect<ObservationPage, ResourcePageRequestError | BundleDecodeError> =>
  fetchResourcePage(client, observationBasedOnRead, cursor)

export {
  fetchObservationBasedOnPage,
  fetchObservationPage,
  type ObservationBasedOnFirstPage,
  type ObservationBasedOnPageCursor,
  type ObservationPage,
  type ObservationPageCursor,
  type ObservationResource,
}
