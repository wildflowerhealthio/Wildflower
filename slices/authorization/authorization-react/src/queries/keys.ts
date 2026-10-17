/**
 * Query-key roots shared across the authorization server resource modules.
 *
 * Mutations invalidate the matching root so the next render refetches.
 */

const GRANTS_QUERY_KEY = ['authorization', 'grants'] as const
const grantQueryKey = (id: string): readonly [string, string, string] => [
  'authorization',
  'grant',
  id,
]
const CLIENTS_QUERY_KEY = ['authorization', 'clients'] as const
const BROWSER_SESSIONS_QUERY_KEY = ['authorization', 'browser-sessions'] as const

export { BROWSER_SESSIONS_QUERY_KEY, CLIENTS_QUERY_KEY, GRANTS_QUERY_KEY, grantQueryKey }
