export {
  buildDeviceLoginTarget,
  buildStepUpTarget,
  DEVICE_LOGIN_ROUTE,
  // Exported for `launcher-web`'s step-up test, which reads the params back
  // off the router with the decoder the screen itself uses rather than a
  // hand-rolled one — the point of that assertion.
  parseDeviceLoginSearch,
  parseRequestScopes,
} from './device-login-route.ts'

export {
  buildAuthorizationServerClientLayer,
  type AuthorizationServerClientRequirements,
} from './client/authorization-server-client.ts'

export * as AuthorizationRouterContext from './router-context.ts'

export {
  CLIENTS_QUERY_KEY,
  clientsQueryOptions,
  deviceConsentQueryOptions,
  GRANTS_QUERY_KEY,
  grantQueryOptions,
  grantsQueryOptions,
  oauthConsentQueryOptions,
  useDeviceConsentMutation,
  useDeviceConsentQuery,
  useGrantQuery,
  useGrantsQuery,
  useOAuthConsentMutation,
  useOAuthConsentQuery,
  useClientsQuery,
  useUpdateClientMutation,
  useRevokeGrantMutation,
  useRunAuthed,
  type ApproveOAuthPayload,
  type AppGrant,
  type Client,
  type DeviceGrant,
  type Grant,
  type RevokeGrantVariables,
  type RunAuthed,
} from './queries/index.ts'

export { TrustedAppsSection } from './components/TrustedAppsSection.tsx'

export { formatInstant } from './format-date.ts'

export { NeedsAuthMessage, sanitizeReturnTo } from './components/NeedsAuthMessage.tsx'

export { makeAwaitLandingAuthReady } from './client/auth-ready.ts'

export {
  authorizationLogoutSettingsItem,
  logOutBearerSession,
  type BearerLogoutDeps,
} from './logout.ts'

export {
  makeBearerAuthStateStore,
  type BearerAuthStateStore,
  type BearerSession,
} from './client/bearer-auth-state-store.ts'

export {
  TokenResponseHandlerContext,
  useTokenResponseHandler,
  type TokenResponseHandler,
} from './client/token-response-handler.ts'
