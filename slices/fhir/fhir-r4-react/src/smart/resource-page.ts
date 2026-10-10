import { Data, Effect, Either, Array as Arr, Schema, Schedule } from 'effect'
import type { ParseError } from 'effect/ParseResult'
import type Client from 'fhirclient/lib/Client'

/**
 * The page size a reader pins with `_count`, instead of a server's default
 * (commonly 10–50, which turns a year of observations into dozens of round trips).
 *
 * @remarks
 * {@link fetchResourcePage} never applies it — `_count` belongs to the read's own
 * `firstPageQuery`, because pinning one is a per-read decision.
 * Every reader here pins it.
 */
const RESOURCE_PAGE_SIZE = 200

/**
 * How a page request the network dropped is retried: up to 3 more attempts,
 * backing off 250 ms → 500 ms → 1 s, so a read gives up about 2 s after its
 * first try. `Schedule.intersect` stops on whichever of "3 retries" and
 * "exponential" says stop first — `Schedule.union` would retry forever.
 */
const DROPPED_REQUEST_RETRY_SCHEDULE = Schedule.exponential('250 millis').pipe(
  Schedule.intersect(Schedule.recurs(3))
)

/**
 * Whether `client.request` rejected because no HTTP response arrived at all,
 * rather than with an HTTP error.
 *
 * @remarks
 * fhirclient's `request` is `fetch(...).then(checkResponse)`: any response that
 * is not `ok` rejects with its `HttpError` (an `Error` carrying the `status`),
 * while `fetch` itself rejects with a `TypeError` when the request never got a
 * response — a CORS or Local Network Access block, a dropped connection, a
 * server that is down. An aborted request rejects with a `DOMException` named
 * `AbortError`, which is not a `TypeError` and so is not a dropped request:
 * whoever aborted it does not want it reissued.
 */
const isDroppedRequest = (cause: unknown): boolean => cause instanceof TypeError

class ResourcePageRequestError extends Data.TaggedError('ResourcePageRequestError')<{
  readonly cause: unknown
}> {}

/**
 * A search's `next` link pointed back at a page already read, so following it
 * would never end.
 */
class ResourcePageCycleError extends Data.TaggedError('ResourcePageCycleError')<{
  /** The `next`-link URL that had already been read. */
  readonly pageUrl: string
}> {}

class BundleDecodeError extends Data.TaggedError('BundleDecodeError')<{
  readonly cause: ParseError
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
const decodeBundlePage = Schema.decodeUnknown(BundlePage)

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
 * A request the network dropped — no HTTP response arrived, as when a browser's
 * CORS or Local Network Access check fails it — is reissued with exponential
 * backoff ({@link DROPPED_REQUEST_RETRY_SCHEDULE}); the search is a GET, so
 * reissuing it is safe. An HTTP error (401, 403, 404, 5xx, …) and an aborted
 * request are not retried.
 *
 * Both the request itself and the bundle decode surface failures through the
 * error channel: an HTTP error, or a dropped request still failing after its
 * retries, yields {@link ResourcePageRequestError} carrying the last attempt's
 * cause, and a response that does not decode as a bundle page yields
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
    }).pipe(
      Effect.retry({
        schedule: DROPPED_REQUEST_RETRY_SCHEDULE,
        while: (error) => isDroppedRequest(error.cause),
      })
    )

    const page = yield* decodeBundlePage(bundle).pipe(
      Effect.mapError((cause) => new BundleDecodeError({ cause, response: bundle }))
    )

    const decodeResource = Schema.decodeUnknown(read.schema)
    const decodeEffects = (page.entry ?? []).map((entry) =>
      decodeResource(entry.resource).pipe(
        Effect.mapError((cause) => new BundleDecodeError({ cause, response: entry.resource })),
        Effect.either
      )
    )
    const results = yield* Effect.all(decodeEffects)
    const items: A[] = Arr.filterMap(results, Either.getRight)
    const droppedEntries = Arr.filterMap(results, Either.getLeft)

    const next = (page.link ?? []).find((link) => link.relation === 'next')?.url
    return {
      items,
      nextPageUrl: next === undefined || next === null || next === '' ? null : next,
      droppedEntryCount: droppedEntries.length,
    }
  })

/**
 * Read every page of a paged search, from its first page to the one with no
 * `next` link, for a caller that needs the whole result rather than a page at
 * a time (a decision over a patient's whole history, say).
 *
 * @typeParam A - The decoded resource type
 * @typeParam First - The first-page input the page reader takes
 * @typeParam E - The page reader's error
 * @param fetchPage - One of this module's page readers, bound to its client —
 *   e.g. `(cursor) => fetchProcedurePage(client, cursor)`
 * @param first - The first page's input
 * @returns An effect yielding every page's decoded resources in server order
 *   and the total count of entries that failed to decode
 *
 * @remarks
 * Takes a page reader rather than a {@link PagedResourceRead}, so every reader
 * here — each keeping its descriptor private — pages the same way.
 *
 * A server whose `next` link names a page already read would loop forever;
 * that fails with {@link ResourcePageCycleError} instead. A failed page fails
 * the whole read: a partial history is not the whole history.
 */
const fetchAllResourcePages = <A, First, E>(
  fetchPage: (cursor: ResourcePageCursor<First>) => Effect.Effect<ResourcePage<A>, E>,
  first: First
): Effect.Effect<Omit<ResourcePage<A>, 'nextPageUrl'>, E | ResourcePageCycleError> =>
  Effect.gen(function* () {
    const items: A[] = []
    let droppedEntryCount = 0
    const readPageUrls = new Set<string>()
    let cursor: ResourcePageCursor<First> = { first }
    for (;;) {
      const page: ResourcePage<A> = yield* fetchPage(cursor)
      items.push(...page.items)
      droppedEntryCount += page.droppedEntryCount
      if (page.nextPageUrl === null) return { items, droppedEntryCount }
      if (readPageUrls.has(page.nextPageUrl)) {
        return yield* new ResourcePageCycleError({ pageUrl: page.nextPageUrl })
      }
      readPageUrls.add(page.nextPageUrl)
      cursor = { pageUrl: page.nextPageUrl }
    }
  })

export {
  BundleDecodeError,
  RESOURCE_PAGE_SIZE,
  ResourcePageCycleError,
  ResourcePageRequestError,
  fetchAllResourcePages,
  fetchResourcePage,
  type PagedResourceRead,
  type ResourcePage,
  type ResourcePageCursor,
}
