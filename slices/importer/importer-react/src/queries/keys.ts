/**
 * Query-key roots for the importer's reads and writes.
 *
 * @remarks
 * Kept in one place so the upload mutation and the list read agree on exactly
 * which key to invalidate: an upload writes a new archive `DocumentReference`,
 * and the server list must refetch under the same key or the just-uploaded
 * archive will not appear until something else evicts the cache.
 */

/** Root key for every importer read. */
const IMPORTER_QUERY_KEY = ['importer'] as const

/**
 * Key root for the paged `DocumentReference` read that backs the server archive
 * list. The page size is appended by the query options, since two different page
 * sizes are two different pagings of the same table rather than one cache entry.
 */
const HAR_ARCHIVES_QUERY_KEY = [...IMPORTER_QUERY_KEY, 'har-archives'] as const

export { HAR_ARCHIVES_QUERY_KEY, IMPORTER_QUERY_KEY }
