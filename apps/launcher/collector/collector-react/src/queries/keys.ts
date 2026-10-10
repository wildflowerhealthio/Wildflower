/**
 * Query-key roots shared across the collector resource modules.
 *
 * Mutations invalidate the matching root so the next render refetches.
 * List + detail share the `collector` namespace so a create/update/delete
 * on one remote invalidates both the accounts list and that remote's
 * edit-form detail.
 */

const REMOTES_QUERY_KEY = ['collector', 'remotes'] as const
const remoteQueryKey = (id: string): readonly [string, string, string] => [
  'collector',
  'remote',
  id,
]

export { REMOTES_QUERY_KEY, remoteQueryKey }
