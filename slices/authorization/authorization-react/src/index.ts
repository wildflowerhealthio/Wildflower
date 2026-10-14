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
  type DeviceGrant,
  type Grant,
  type RevokeGrantVariables,
  type RunAuthed,
} from './queries/index.ts'

export { TrustedAppsSection } from './components/TrustedAppsSection.tsx'

export { formatInstant } from './format-date.ts'

export { sanitizeReturnTo } from './return-to.ts'

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
