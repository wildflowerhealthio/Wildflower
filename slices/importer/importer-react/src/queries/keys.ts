/**
 * Query-key roots for the importer's reads and writes.
 *
 * @remarks
 * Kept in one place so the upload mutation and the list read agree on exactly
 * which key to invalidate: an upload writes a new source-file
 * `DocumentReference`, and the server list must refetch under the same key or
 * the just-uploaded source file will not appear until something else evicts
 * the cache.
 */

/** Root key for every importer read. */
const IMPORTER_QUERY_KEY = ['importer'] as const

/**
 * Key root for the paged `DocumentReference` read that backs the server
 * source-file list. The list spans every registered format's source files in
 * one search, so the key names no format; the page size is appended by the
 * query options, since two different page sizes are two different pagings
 * of the same table rather than one cache entry.
 */
const SOURCE_FILES_QUERY_KEY = [...IMPORTER_QUERY_KEY, 'source-files'] as const

/**
 * Key root for the stored Patients and Practitioners the referent rows offer,
 * one key per resource type under it. Read once per review and invalidated by
 * a confirm, the one thing that changes them.
 */
const STORED_RESOURCES_QUERY_KEY = [...IMPORTER_QUERY_KEY, 'stored'] as const

export { IMPORTER_QUERY_KEY, SOURCE_FILES_QUERY_KEY, STORED_RESOURCES_QUERY_KEY }
