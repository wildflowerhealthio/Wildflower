export { gatekeeperSettingsItemsFragment } from './settings-fragments.ts'

export {
  buildDeviceLoginTarget,
  buildStepUpTarget,
  DEVICE_LOGIN_ROUTE,
  // Exported for `wildflower-react`'s step-up test, which reads the params back
  // off the router with the decoder the screen itself uses rather than a
  // hand-rolled one — the point of that assertion.
  parseDeviceLoginSearch,
  parseRequestScopes,
} from './device-login-route.ts'

export {
  buildGatekeeperClientLayer,
  type GatekeeperClientRequirements,
} from './client/gatekeeper-client.ts'

export * as GatekeeperRouterContext from './router-context.ts'

export {
  deviceConsentQueryOptions,
  GRANTS_QUERY_KEY,
  grantQueryOptions,
  grantsQueryOptions,
  oauthConsentQueryOptions,
  REQUESTS_QUERY_KEY,
  requestQueryOptions,
  requestsQueryOptions,
  useDecideRequestMutation,
  useDeviceConsentMutation,
  useDeviceConsentQuery,
  useGrantQuery,
  useGrantsQuery,
  useOAuthConsentMutation,
  useOAuthConsentQuery,
  useRequestQuery,
  useRequestsQuery,
  useRevokeGrantMutation,
  useRunAuthed,
  type ApproveOAuthPayload,
  type Grant,
  type HttpRequest,
  type RequestDecision,
  type RunAuthed,
} from './queries/index.ts'

export { NeedsAuthMessage, sanitizeReturnTo } from './components/NeedsAuthMessage.tsx'

export {
  EMBEDDED_TOKEN_TIMEOUT,
  makeAwaitEmbeddedAuthReady,
  makeAwaitLandingAuthReady,
  TokenTimeout,
} from './client/auth-ready.ts'

export { makeEmbeddedAuthStateStore } from './client/auth-state-store.ts'

export {
  gatekeeperLogoutSettingsItem,
  logOutBearerSession,
  type BearerLogoutDeps,
} from './logout.ts'

export {
  makeBearerAuthStateStore,
  type BearerAuthStateStore,
} from './client/bearer-auth-state-store.ts'

export {
  TokenResponseHandlerContext,
  useTokenResponseHandler,
  type TokenResponseHandler,
} from './client/token-response-handler.ts'

export {
  ActivePendingConsentProvider,
  makeActivePendingConsentStore,
  useActivePendingConsent,
  type ActivePendingConsentProviderProps,
  type ActivePendingConsentStore,
} from './active-pending-consent/index.ts'

export { PendingConsentModalHost } from './screens/pending-consent/pending-consent-modal-host.tsx'
