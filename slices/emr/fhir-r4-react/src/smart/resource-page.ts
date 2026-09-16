import { Option, Schema } from 'effect'
import type Client from 'fhirclient/lib/Client'

/**
 * The page size every reader built on {@link fetchResourcePage} pins with
 * `_count`, so a page is one screenful-plus rather than a server's default
 * (commonly 10–50, which turns a year of observations into dozens of round
 * trips).
 */
const RESOURCE_PAGE_SIZE = 200

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
 * One page of a paged FHIR search: the resources this page decoded and the
 * cursor to the page after it.
 *
 * @typeParam A - The decoded resource type the page carries
 */
interface ResourcePage<A> {
  /** The page's entries that decoded through the read's schema, in server order. */
  readonly items: readonly A[]
  /** The `next`-link URL to pass back as `{ pageUrl }`, or `null` on the last page. */
  readonly nextPageUrl: string | null
}

/**
 * The cursor {@link fetchResourcePage} reads from: `{ first }` opens the search
 * (the payload is whatever the read's `firstPageQuery` needs to build its search
 * parameters), and `{ pageUrl }` continues it from a previous page's
 * {@link ResourcePage.nextPageUrl}.
 *
 * @typeParam First - The first-page input the read's `firstPageQuery` consumes
 */
type ResourcePageCursor<First> = { readonly first: First } | { readonly pageUrl: string }

/**
 * A paged read of one FHIR resource type: everything {@link fetchResourcePage}
 * needs that is resource-specific.
 *
 * @typeParam A - The decoded resource type
 * @typeParam I - The resource's FHIR wire (encoded) type
 * @typeParam First - The first-page input {@link PagedResourceRead.firstPageQuery} consumes
 */
interface PagedResourceRead<A, I, First> {
  /** The FHIR resource type name, used as the search's path segment (e.g. `'Observation'`). */
  readonly resourceType: string
  /** The schema every `entry.resource` is decoded through; entries that fail it are dropped. */
  readonly schema: Schema.Schema<A, I, never>
  /**
   * Builds the first page's search parameters — already URL-encoded, without the
   * leading `?`, which {@link fetchResourcePage} joins to `resourceType`.
   */
  readonly firstPageQuery: (first: First) => string
}

/**
 * Fetch a single page of one FHIR resource type from a SMART FHIR server and
 * report the cursor to the next page, so a caller can page on demand (e.g.
 * scroll-driven loading) instead of reading every page up front.
 *
 * @typeParam A - The decoded resource type
 * @typeParam I - The resource's FHIR wire (encoded) type
 * @typeParam First - The first-page input `read.firstPageQuery` consumes
 * @param client - The SMART client the search is issued through
 * @param read - What makes this read resource-specific: see {@link PagedResourceRead}
 * @param cursor - Where to read from: `{ first }` for the first page, `{ pageUrl }` for a later one
 * @returns The page's decoded resources and the next page's cursor
 *
 * @remarks
 * A `{ pageUrl }` cursor is passed to the client verbatim — the server's own
 * `next` link already carries scope, sort and paging state. fhirclient's default
 * `pageLimit: 1` means each call returns exactly one bundle page.
 *
 * Both decodes are lenient, because a viewer that renders nothing is worse than
 * one that renders what a server got right: a response that is not a bundle
 * yields an empty last page, and one malformed entry drops that row alone.
 */
const fetchResourcePage = async <A, I, First>(
  client: Client,
  read: PagedResourceRead<A, I, First>,
  cursor: ResourcePageCursor<First>
): Promise<ResourcePage<A>> => {
  const query =
    'pageUrl' in cursor
      ? cursor.pageUrl
      : `${read.resourceType}?${read.firstPageQuery(cursor.first)}`
  const bundle = await client.request<unknown>(query)
  const page = decodeBundlePage(bundle)
  if (Option.isNone(page)) return { items: [], nextPageUrl: null }

  const decodeResource = Schema.decodeUnknownOption(read.schema)
  const items = (page.value.entry ?? []).flatMap((entry) => {
    const decoded = decodeResource(entry.resource)
    return Option.isSome(decoded) ? [decoded.value] : []
  })
  const next = (page.value.link ?? []).find((link) => link.relation === 'next')?.url
  return { items, nextPageUrl: next === undefined || next === null || next === '' ? null : next }
}

export {
  RESOURCE_PAGE_SIZE,
  fetchResourcePage,
  type PagedResourceRead,
  type ResourcePage,
  type ResourcePageCursor,
}
