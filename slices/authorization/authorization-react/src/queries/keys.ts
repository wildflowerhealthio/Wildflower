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
}
