/**
 * The gatekeeper TanStack-Query surface, split by the resource each module
 * deals with:
 *
 *   - {@link file://./grants.ts}          — access-management grants (list + detail + revoke)
 *   - {@link file://./requests.ts}        — access-management HTTP requests (list + detail + decide)
 *   - {@link file://./device-consent.ts}  — RFC 8628 device-authorization consent
 *   - {@link file://./oauth-consent.ts}   — OAuth authorization-code consent
 *
 * Shared scaffolding lives in {@link file://./keys.ts} (the query-key roots
 * mutations invalidate) and {@link file://./use-run-authed.ts} (the authed-runner
 * hook each `queryFn` reads from router context).
 *
 * Re-exported flat so call sites import from `./queries` without caring
 * which resource module a hook lives in.
 */

export { GRANTS_QUERY_KEY, REQUESTS_QUERY_KEY } from './keys.ts'
export { useRunAuthed } from './use-run-authed.ts'

export {
  grantQueryOptions,
  grantsQueryOptions,
  useGrantQuery,
  useGrantsQuery,
  useRevokeGrantMutation,
} from './grants.ts'
export type { Grant } from './grants.ts'

export {
  requestQueryOptions,
  requestsQueryOptions,
  useDecideRequestMutation,
  useRequestQuery,
  useRequestsQuery,
} from './requests.ts'
export type { HttpRequest, RequestDecision } from './requests.ts'

export {
  deviceConsentQueryOptions,
  useDeviceConsentMutation,
  useDeviceConsentQuery,
} from './device-consent.ts'
export type { DeviceConsent } from './device-consent.ts'

export {
  oauthConsentQueryOptions,
  useOAuthConsentMutation,
  useOAuthConsentQuery,
} from './oauth-consent.ts'
export type {
  ApproveOAuthPayload,
  OAuthConsentResource,
  OAuthConsentResult,
} from './oauth-consent.ts'

export type { RunAuthed } from '../router-context.ts'
