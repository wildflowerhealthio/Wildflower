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

export { TRACE_EXCHANGES_QUERY_KEY, WEB_TRACE_QUERY_KEY }
