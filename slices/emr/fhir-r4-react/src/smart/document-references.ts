import type { Effect, Schema } from 'effect'
import { DocumentReference } from 'fhir-r4/resources'
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

/** The decoded FHIR R4 `DocumentReference` resource. */
type DocumentReferenceResource = Schema.Schema.Type<typeof DocumentReference.Schema>

/**
 * One page of a `DocumentReference` read: the decoded resources on this page
 * and the cursor to the next page (`null` when this is the last page).
 */
type DocumentReferencePage = ResourcePage<DocumentReferenceResource>

/**
 * The first-page input for {@link fetchDocumentReferencePage}. Supports
 * optional patient scoping and category filtering — the two search parameters
 * the importer's source-file listing and other consumers need.
 */
interface DocumentReferenceFirstPage {
  /**
   * The patient to scope the search to, or `null` for an unscoped search
   * that returns every `DocumentReference` the session's granted scopes
   * expose.
   */
  readonly patientId: string | null
  /**
   * A comma-joined `system|code` category token string to filter on, or
   * `null` for no category filter. FHIR's search grammar is "OR within a
   * comma-joined value", so `"s1|c1,s2|c2"` matches a `DocumentReference`
   * whose `category` contains either token.
   */
  readonly category: string | null
}

/**
 * The cursor {@link fetchDocumentReferencePage} reads from. `first` carries
 * patient scope and an optional category filter; `{ pageUrl }` continues
 * from a previous page's `nextPageUrl`.
 */
type DocumentReferencePageCursor = ResourcePageCursor<DocumentReferenceFirstPage>

// Newest first, server-side, so the most recently uploaded documents
// appear at the top of the list and scroll paging appends without
// reordering.
const SEARCH_PARAMS = `_sort=-date&_count=${RESOURCE_PAGE_SIZE}`

/** The `DocumentReference` read descriptor. */
const documentReferenceRead: PagedResourceRead<
  DocumentReferenceResource,
  Schema.Schema.Encoded<typeof DocumentReference.Schema>,
  DocumentReferenceFirstPage
> = {
  resourceType: 'DocumentReference',
  schema: DocumentReference.Schema,
  firstPageQuery: ({ patientId, category }: DocumentReferenceFirstPage): string => {
    const parts: string[] = []
    if (patientId !== null) parts.push(`patient=${encodeURIComponent(patientId)}`)
    if (category !== null) parts.push(`category=${encodeURIComponent(category)}`)
    parts.push(SEARCH_PARAMS)
    return parts.join('&')
  },
}

/**
 * Fetch a single page of `DocumentReference`s from the SMART FHIR server and
 * report the cursor to the next page.
 *
 * @param client - The SMART client the search is issued through
 * @param cursor - Patient scope and category filter for the first page, or a
 *   previous page's `nextPageUrl`
 * @returns An effect yielding the page's decoded `DocumentReference`s and the
 *   next page's cursor
 *
 * @remarks
 * The patient id is a parameter rather than something this reader lifts off
 * `client.patient.id`, so the caller decides what "no patient in context" means
 * for its launch; `null` drops the `patient=` filter entirely.
 *
 * The `category` filter supports FHIR's comma-OR syntax, so a caller can pass
 * multiple `system|code` tokens to match any of several document categories in
 * a single round trip — the same pattern the importer's source-file listing
 * uses to span every registered format.
 */
const fetchDocumentReferencePage = (
  client: Client,
  cursor: DocumentReferencePageCursor
): Effect.Effect<DocumentReferencePage, ResourcePageRequestError | BundleDecodeError> =>
  fetchResourcePage(client, documentReferenceRead, cursor)

export {
  fetchDocumentReferencePage,
  type DocumentReferenceFirstPage,
  type DocumentReferencePage,
  type DocumentReferencePageCursor,
  type DocumentReferenceResource,
}
