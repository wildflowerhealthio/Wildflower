/**
 * Query-key roots shared across the gatekeeper resource modules.
 *
 * Mutations invalidate the matching root so the next render refetches.
 * List + detail share a root so a decision on one request (or grant)
 * invalidates both surfaces.
 */

const GRANTS_QUERY_KEY = ['gatekeeper', 'grants'] as const
const grantQueryKey = (id: string): readonly [string, string, string] => ['gatekeeper', 'grant', id]
const CLIENTS_QUERY_KEY = ['gatekeeper', 'clients'] as const
const REQUESTS_QUERY_KEY = ['gatekeeper', 'requests'] as const
const requestQueryKey = (id: string): readonly [string, string, string] => [
  'gatekeeper',
  'request',
  id,
]
const deviceConsentQueryKey = (userCode: string): readonly [string, string, string] => [
  'gatekeeper',
  'device-consent',
  userCode,
]
const oauthConsentQueryKey = (id: string): readonly [string, string, string] => [
  'gatekeeper',
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
