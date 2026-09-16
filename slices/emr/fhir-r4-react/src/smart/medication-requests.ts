import type { Schema } from 'effect'
import { MedicationRequest } from 'fhir-r4/resources'
import type Client from 'fhirclient/lib/Client'

import { fetchResourcePage, type PagedResourceRead, type ResourcePage } from './resource-page.ts'

/** The decoded FHIR R4 `MedicationRequest` resource. */
type MedicationRequestResource = Schema.Schema.Type<typeof MedicationRequest.Schema>

/**
 * One page of a `MedicationRequest` read: the decoded resources on this page and
 * the cursor to the next page (`null` when this is the last page).
 */
type MedicationRequestPage = ResourcePage<MedicationRequestResource>

/**
 * The cursor {@link fetchMedicationRequestPage} reads from. The first page is
 * opened by patient scope — a `string` patientId, or `null` for a `system/`
 * launch with no patient in context — and every subsequent page by the absolute
 * `next`-link URL the previous page returned.
 */
type MedicationRequestCursor = { readonly patientId: string | null } | { readonly pageUrl: string }

// Newest-authored first, server-side, so scroll paging can append each page
// without reordering rows already on screen. `authoredon` is the FHIR R4
// `MedicationRequest` search parameter backing the `authoredOn` element.
const SORT_PARAM = '_sort=-authoredon'

/**
 * The `MedicationRequest` read. Deliberately pins no `_count`: `medications-app`
 * pages against whatever size the server picks, so naming one here would change
 * a shipped app's paging behaviour.
 */
const medicationRequestRead: PagedResourceRead<
  MedicationRequestResource,
  Schema.Schema.Encoded<typeof MedicationRequest.Schema>,
  string | null
> = {
  resourceType: 'MedicationRequest',
  schema: MedicationRequest.Schema,
  firstPageQuery: (patientId: string | null): string =>
    patientId === null ? SORT_PARAM : `patient=${encodeURIComponent(patientId)}&${SORT_PARAM}`,
}

/**
 * Fetch a single page of `MedicationRequest`s from the SMART FHIR server and
 * report the cursor to the next page, so a caller can page on demand (e.g.
 * scroll-driven loading) instead of reading every page up front.
 *
 * @param client - The SMART client the search is issued through
 * @param cursor - Patient scope for the first page, or a previous page's `nextPageUrl`
 * @returns The page's decoded `MedicationRequest`s and the next page's cursor
 *
 * @remarks
 * A thin patient-scoped wrapper over {@link fetchResourcePage}, which owns the
 * paging, the permissive bundle decode and the per-entry decode-or-drop. Pages
 * arrive newest-authored first ({@link SORT_PARAM}), which is what lets a caller
 * append them without reordering earlier rows.
 */
const fetchMedicationRequestPage = async (
  client: Client,
  cursor: MedicationRequestCursor
): Promise<MedicationRequestPage> =>
  fetchResourcePage(
    client,
    medicationRequestRead,
    'pageUrl' in cursor ? { pageUrl: cursor.pageUrl } : { first: cursor.patientId }
  )

export {
  fetchMedicationRequestPage,
  type MedicationRequestCursor,
  type MedicationRequestPage,
  type MedicationRequestResource,
}
