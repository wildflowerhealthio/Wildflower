/**
 * Query-key roots for the web-trace reads.
 *
 * @remarks
 * The viewer is read-only — capture writes happen in a collector, not here — so
 * nothing in this package invalidates these keys. They still live in one place
 * so a later write surface has a single source of truth to invalidate against.
 */

/** Root key for every web-trace read. */
const WEB_TRACE_QUERY_KEY = ['web-trace'] as const

/**
 * Key root for the paged `DocumentReference` read that backs the recordings
 * tab. The page size is appended by the query options, since two different page
 * sizes are two different pagings of the same table rather than one cache entry.
 */
const TRACE_EXCHANGES_QUERY_KEY = [...WEB_TRACE_QUERY_KEY, 'exchanges'] as const

/**
 * Key root for the paged `DocumentReference` read that backs the documents
 * browser. Separate from {@link TRACE_EXCHANGES_QUERY_KEY} even though both
 * search the same resource type: one is narrowed to the web-trace category and
 * decoded through the trace codec, the other is category-agnostic and not
 * decoded at all, so they are different reads with different page shapes rather
 * than one read with a parameter. The active filters are appended by the query
 * options — a different filter set is a different search, not a stale cache
 * entry for the same one.
 */
const DOCUMENTS_QUERY_KEY = [...WEB_TRACE_QUERY_KEY, 'documents'] as const

export { DOCUMENTS_QUERY_KEY, TRACE_EXCHANGES_QUERY_KEY, WEB_TRACE_QUERY_KEY }
