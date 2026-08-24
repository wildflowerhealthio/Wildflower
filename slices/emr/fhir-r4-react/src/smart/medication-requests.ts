import { Option, Schema } from 'effect'
import { MedicationRequest } from 'fhir-r4/resources'
import type Client from 'fhirclient/lib/Client'

/** The decoded FHIR R4 `MedicationRequest` resource. */
type MedicationRequestResource = Schema.Schema.Type<typeof MedicationRequest.Schema>

const decodeMedicationRequest = Schema.decodeUnknownOption(MedicationRequest.Schema)

// One search-result page: only the `entry[].resource`s and the paging `link`s
// are read. Decoded permissively (excess keys ignored, every field optional and
// nullable) so a server that omits `entry` or `link` yields an empty page rather
// than a decode failure.
const BundlePage = Schema.Struct({
  entry: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Struct({ resource: Schema.optional(Schema.Unknown) })))
  ),
  link: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          relation: Schema.optional(Schema.NullOr(Schema.String)),
          url: Schema.optional(Schema.NullOr(Schema.String)),
        })
      )
    )
  ),
})
const decodeBundlePage = Schema.decodeUnknownOption(BundlePage)

/**
 * One page of a `MedicationRequest` read: the decoded resources on this page and
 * the cursor to the next page (`null` when this is the last page).
 */
interface MedicationRequestPage {
  readonly items: readonly MedicationRequestResource[]
  readonly nextPageUrl: string | null
}

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

const firstPageQuery = (patientId: string | null): string =>
  patientId === null
    ? `MedicationRequest?${SORT_PARAM}`
    : `MedicationRequest?patient=${encodeURIComponent(patientId)}&${SORT_PARAM}`

/**
 * Fetch a single page of `MedicationRequest`s from the SMART FHIR server and
 * report the cursor to the next page, so a caller can page on demand (e.g.
 * scroll-driven loading) instead of reading every page up front.
 *
 * The first page is requested by patient scope; later pages are fetched by
 * passing the previous page's {@link MedicationRequestPage.nextPageUrl} back as
 * `{ pageUrl }`. fhirclient's default `pageLimit: 1` means each call returns
 * exactly one bundle page. Each entry is decoded through the fhir-r4 schema;
 * anything that fails to decode is dropped, so a single malformed row never
 * fails the whole page. Pages arrive newest-authored first ({@link SORT_PARAM}),
 * which is what lets a caller append them without reordering earlier rows.
 */
const fetchMedicationRequestPage = async (
  client: Client,
  cursor: MedicationRequestCursor
): Promise<MedicationRequestPage> => {
  const query = 'pageUrl' in cursor ? cursor.pageUrl : firstPageQuery(cursor.patientId)
  const bundle = await client.request<unknown>(query)
  const page = decodeBundlePage(bundle)
  if (Option.isNone(page)) return { items: [], nextPageUrl: null }

  const items = (page.value.entry ?? []).flatMap((entry) => {
    const decoded = decodeMedicationRequest(entry.resource)
    return Option.isSome(decoded) ? [decoded.value] : []
  })
  const next = (page.value.link ?? []).find((link) => link.relation === 'next')?.url
  return { items, nextPageUrl: next === undefined || next === null || next === '' ? null : next }
}

export {
  fetchMedicationRequestPage,
  type MedicationRequestCursor,
  type MedicationRequestPage,
  type MedicationRequestResource,
}
