import type { Effect, Schema } from 'effect'
import { withMandatoryId } from 'fhir-r4/data-types'
import { Procedure } from 'fhir-r4/resources'
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
 * The schema every `Procedure` entry decodes through: the R4 resource with its
 * `id` required, as the FHIR server always returns one. An entry without an
 * `id` fails the decode.
 */
const ProcedureWithIdSchema = withMandatoryId(Procedure.Schema)

/** The decoded FHIR R4 `Procedure` resource, `id` present. */
type ProcedureResource = Schema.Schema.Type<typeof ProcedureWithIdSchema>

/**
 * One page of a `Procedure` read: the decoded resources on this page and the
 * cursor to the next page (`null` when this is the last page).
 */
type ProcedurePage = ResourcePage<ProcedureResource>

/** The first-page input for {@link fetchProcedurePage}. */
interface ProcedureFirstPage {
  /**
   * The patient to scope the search to, or `null` for an unscoped search that
   * returns every matching `Procedure` the session's granted scopes expose.
   */
  readonly patientId: string | null
  /** The `system|code` token the procedures carry as `category`, sent as the `category` parameter. */
  readonly categoryToken: string
  /**
   * The canonical url the procedures name in `instantiatesCanonical` — the
   * definition they carry out — sent as the `instantiates-canonical` parameter,
   * or `null` for every definition (to find which ones the patient follows).
   */
  readonly instantiatesCanonicalUrl: string | null
}

/**
 * The cursor {@link fetchProcedurePage} reads from. `first` carries the patient
 * scope, category and definition; `{ pageUrl }` continues from a previous
 * page's `nextPageUrl`.
 */
type ProcedurePageCursor = ResourcePageCursor<ProcedureFirstPage>

// Oldest-performed first, server-side, so scroll paging can append each page
// without reordering rows already on screen (`date` is the FHIR R4 `Procedure`
// search parameter backing `performed[x]`).
const SEARCH_PARAMS = `_sort=date&_count=${RESOURCE_PAGE_SIZE}`

/** The `Procedure` read: the procedures of one category carrying out one definition. */
const procedureRead: PagedResourceRead<
  ProcedureResource,
  Schema.Schema.Encoded<typeof ProcedureWithIdSchema>,
  ProcedureFirstPage
> = {
  resourceType: 'Procedure',
  schema: ProcedureWithIdSchema,
  firstPageQuery: ({
    patientId,
    categoryToken,
    instantiatesCanonicalUrl,
  }: ProcedureFirstPage): string => {
    const parts: string[] = []
    if (patientId !== null) parts.push(`patient=${encodeURIComponent(patientId)}`)
    parts.push(`category=${encodeURIComponent(categoryToken)}`)
    if (instantiatesCanonicalUrl !== null) {
      parts.push(`instantiates-canonical=${encodeURIComponent(instantiatesCanonicalUrl)}`)
    }
    parts.push(SEARCH_PARAMS)
    return parts.join('&')
  },
}

/**
 * Fetch a single page of the `Procedure`s of one category that carry out one
 * definition, and report the cursor to the next page.
 *
 * @param client - The SMART client the search is issued through
 * @param cursor - Patient scope, category and definition for the first page,
 *   or a previous page's `nextPageUrl`
 * @returns An effect yielding the page's decoded `Procedure`s and the next page's cursor
 *
 * @remarks
 * Every `status` is read — which statuses a caller can use is its own
 * decision, made when it decodes the page. The patient id is a parameter
 * rather than something this reader lifts off `client.patient.id`, so the
 * caller decides what "no patient in context" means for its launch; `null`
 * drops the `patient=` filter entirely. A `null` definition drops
 * `instantiates-canonical=`, reading the procedures across every definition.
 * An entry without an `id` is dropped
 * and counted like any other that fails to decode.
 */
const fetchProcedurePage = (
  client: Client,
  cursor: ProcedurePageCursor
): Effect.Effect<ProcedurePage, ResourcePageRequestError | BundleDecodeError> =>
  fetchResourcePage(client, procedureRead, cursor)

export {
  fetchProcedurePage,
  type ProcedureFirstPage,
  type ProcedurePage,
  type ProcedurePageCursor,
  type ProcedureResource,
}
