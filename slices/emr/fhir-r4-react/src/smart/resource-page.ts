import { Data, Effect, Either, Option, Schema } from 'effect'
import type Client from 'fhirclient/lib/Client'

/**
 * The page size a reader pins with `_count`, instead of a server's default
 * (commonly 10–50, which turns a year of observations into dozens of round trips).
 *
 * @remarks
 * {@link fetchResourcePage} never applies it — `_count` belongs to the read's own
 * `firstPageQuery`, because pinning one is a per-read decision.
 * `fetchObservationPage` and `fetchPatientPage` pin it;
 * `fetchMedicationRequestPage` deliberately does not.
 */
const RESOURCE_PAGE_SIZE = 200

class ResourcePageRequestError extends Data.TaggedError('ResourcePageRequestError')<{
  readonly cause: unknown
}> {}

class BundleDecodeError extends Data.TaggedError('BundleDecodeError')<{
  readonly response: unknown
}> {}

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
 * One page of a paged FHIR search: the resources this page decoded, the
 * cursor to the page after it, and a count of entries that failed to decode.
 *
 * @typeParam A - The decoded resource type the page carries
 */
interface ResourcePage<A> {
  /** The page's entries that decoded through the read's schema, in server order. */
  readonly items: readonly A[]
  /** The `next`-link URL to pass back as `{ pageUrl }`, or `null` on the last page. */
  readonly nextPageUrl: string | null
  /** How many entries the server sent that did not decode through the schema. */
  readonly droppedEntryCount: number
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
 * @returns An effect yielding the page's decoded resources and the next page's cursor
 *
 * @remarks
 * A `{ pageUrl }` cursor is passed to the client verbatim — the server's own
 * `next` link already carries scope, sort and paging state. fhirclient's default
 * `pageLimit: 1` means each call returns exactly one bundle page.
 *
 * Both the request itself and the bundle decode surface failures through the
 * error channel: a transport/HTTP failure yields {@link ResourcePageRequestError},
 * and a response that does not decode as a bundle page yields
 * {@link BundleDecodeError}. Per-entry decode failures are tracked in the
 * returned {@link ResourcePage.droppedEntryCount} so the caller can report
 * partial results without losing the page.
 */
const fetchResourcePage = <A, I, First>(
  client: Client,
  read: PagedResourceRead<A, I, First>,
  cursor: ResourcePageCursor<First>
): Effect.Effect<ResourcePage<A>, ResourcePageRequestError | BundleDecodeError> =>
  Effect.gen(function* () {
    const query =
      'pageUrl' in cursor
        ? cursor.pageUrl
        : `${read.resourceType}?${read.firstPageQuery(cursor.first)}`

    const bundle = yield* Effect.tryPromise({
      try: () => client.request<unknown>(query),
      catch: (cause) => new ResourcePageRequestError({ cause }),
    })

    const page = decodeBundlePage(bundle)
    if (Option.isNone(page)) {
      return yield* new BundleDecodeError({ response: bundle })
    }

    const decodeResource = Schema.decodeUnknownEither(read.schema)
    const items: A[] = []
    let droppedEntryCount = 0
    for (const entry of page.value.entry ?? []) {
      const result = decodeResource(entry.resource)
      if (Either.isRight(result)) {
        items.push(result.right)
      } else {
        droppedEntryCount++
      }
    }

    const next = (page.value.link ?? []).find((link) => link.relation === 'next')?.url
    return {
      items,
      nextPageUrl: next === undefined || next === null || next === '' ? null : next,
      droppedEntryCount,
    }
  })

export {
  BundleDecodeError,
  RESOURCE_PAGE_SIZE,
  ResourcePageRequestError,
  fetchResourcePage,
  type PagedResourceRead,
  type ResourcePage,
  type ResourcePageCursor,
}
