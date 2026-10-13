/**
 * Query-key roots shared across the authorization server resource modules.
 *
 * Mutations invalidate the matching root so the next render refetches.
 * List + detail share a root so a decision on one request (or grant)
 * invalidates both surfaces.
 */

const GRANTS_QUERY_KEY = ['authorization', 'grants'] as const
const grantQueryKey = (id: string): readonly [string, string, string] => [
  'authorization',
  'grant',
  id,
]
const CLIENTS_QUERY_KEY = ['authorization', 'clients'] as const
const REQUESTS_QUERY_KEY = ['authorization', 'requests'] as const
const requestQueryKey = (id: string): readonly [string, string, string] => [
  'authorization',
  'request',
  id,
]
const deviceConsentQueryKey = (userCode: string): readonly [string, string, string] => [
  'authorization',
  'device-consent',
  userCode,
]
const oauthConsentQueryKey = (id: string): readonly [string, string, string] => [
  'authorization',
  'oauth-consent',
  id,
]

export {
  CLIENTS_QUERY_KEY,
  deviceConsentQueryKey,
  GRANTS_QUERY_KEY,
  grantQueryKey,
  oauthConsentQueryKey,
  REQUESTS_QUERY_KEY,
  requestQueryKey,
}
