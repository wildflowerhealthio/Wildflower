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
 * The first-page input for {@link fetchObservationBasedOnOrPartOfPage}: the
 * patient scope, and the request the observations were made against, the
 * event they were made during, or both. At least one of the two references is
 * named, so the read never widens to every observation.
 */
type ObservationBasedOnOrPartOfFirstPage = {
  /**
   * The patient to scope the search to, or `null` for an unscoped search that
   * returns every matching `Observation` the session's granted scopes expose.
   */
  readonly patientId: string | null
} & (
  | {
      /** The literal reference the observations name in `basedOn`, e.g. `ServiceRequest/sr-1`. */
      readonly basedOnReference: string
      /** The literal reference the observations name in `partOf`, e.g. `Procedure/pr-1`, or `null` for any. */
      readonly partOfReference: string | null
    }
  | {
      /** No `based-on` narrowing. */
      readonly basedOnReference: null
      /** The literal reference the observations name in `partOf`, e.g. `Procedure/pr-1`. */
      readonly partOfReference: string
    }
)

/**
 * The cursor {@link fetchObservationBasedOnOrPartOfPage} reads from. `first`
 * carries the patient scope and the references; `{ pageUrl }` continues from a
 * previous page's `nextPageUrl`.
 */
type ObservationBasedOnOrPartOfPageCursor = ResourcePageCursor<ObservationBasedOnOrPartOfFirstPage>

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

/** The `Observation` read narrowed to the observations made against a request or during an event. */
const observationBasedOnOrPartOfRead: PagedResourceRead<
  ObservationResource,
  Schema.Schema.Encoded<typeof Observation.Schema>,
  ObservationBasedOnOrPartOfFirstPage
> = {
  resourceType: 'Observation',
  schema: Observation.Schema,
  firstPageQuery: ({
    patientId,
    basedOnReference,
    partOfReference,
  }: ObservationBasedOnOrPartOfFirstPage): string => {
    const parts: string[] = []
    if (patientId !== null) parts.push(`patient=${encodeURIComponent(patientId)}`)
    if (basedOnReference !== null) parts.push(`based-on=${encodeURIComponent(basedOnReference)}`)
    if (partOfReference !== null) parts.push(`part-of=${encodeURIComponent(partOfReference)}`)
    parts.push(SEARCH_PARAMS)
    return parts.join('&')
  },
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
 * Fetch a single page of the `Observation`s made against one request
 * (`based-on`), during one event (`part-of`), or both, and report the cursor to
 * the next page.
 *
 * @param client - The SMART client the search is issued through
 * @param cursor - Patient scope and references for the first page, or a
 *   previous page's `nextPageUrl`
 * @returns An effect yielding the page's decoded `Observation`s and the next page's cursor
 *
 * @remarks
 * The sibling of {@link fetchObservationPage} with the same order (oldest
 * observed first), page size and schema, narrowed server-side by FHIR R4's
 * `Observation` `based-on` and `part-of` search parameters; naming both asks
 * for the observations that carry both. The references are literal
 * (`Type/id`), as the observations name them.
 */
const fetchObservationBasedOnOrPartOfPage = (
  client: Client,
  cursor: ObservationBasedOnOrPartOfPageCursor
): Effect.Effect<ObservationPage, ResourcePageRequestError | BundleDecodeError> =>
  fetchResourcePage(client, observationBasedOnOrPartOfRead, cursor)

export {
  fetchObservationBasedOnOrPartOfPage,
  fetchObservationPage,
  type ObservationBasedOnOrPartOfFirstPage,
  type ObservationBasedOnOrPartOfPageCursor,
  type ObservationPage,
  type ObservationPageCursor,
  type ObservationResource,
}
