export {
  buildAuthorizationServerClientLayer,
  type AuthorizationServerClientRequirements,
} from './client/authorization-server-client.ts'

export * as AuthorizationRouterContext from './router-context.ts'

export {
  BROWSER_SESSIONS_QUERY_KEY,
  browserSessionsQueryOptions,
  CLIENTS_QUERY_KEY,
  clientsQueryOptions,
  deviceConsentMutationOptions,
  ExpiredDeviceConsent,
  GRANTS_QUERY_KEY,
  grantQueryOptions,
  grantsQueryOptions,
  oauthConsentMutationOptions,
  sessionWideningMutationOptions,
  useGrantQuery,
  useGrantsQuery,
  useClientsQuery,
  useUpdateClientMutation,
  useRevokeGrantMutation,
  useBrowserSessionsQuery,
  useRevokeBrowserSessionMutation,
  useRunAuthed,
  type ApproveOAuthPayload,
  type AppGrant,
  type BrowserSession,
  type DeviceConsent,
  type DeviceConsentDecision,
  type DeviceConsentResult,
  type DeviceGrant,
  type Grant,
  type OAuthConsentDecision,
  type OAuthConsentResource,
  type OAuthConsentResult,
  type RevokeBrowserSessionVariables,
  type RevokeGrantVariables,
  type RunAuthed,
  type SessionWideningConsent,
  type SessionWideningDecision,
  type SessionWideningResult,
} from './queries/index.ts'

export { TrustedAppsSection } from './components/TrustedAppsSection.tsx'

// The consent card, for a surface that sends the decision and reads the
// patients on its own session: the authorization server's consent page
// (`apps/host/wildflower-server/authorization-server-web`).
export { consentAsksForPatient } from './screens/oauth-consent/consent-asks-for-patient.ts'
export {
  OAuthConsentCard,
  type OAuthConsentCardProps,
  type OAuthConsentMutation,
  type PatientNameSearch,
  type PatientOptionsState,
} from './screens/oauth-consent/oauth-consent-card.tsx'

// The device-consent card and the code entry before it, for a surface that
// sends the decision on its own session: the authorization server's device
// page (`apps/host/wildflower-server/authorization-server-web`).
export {
  DeviceConsentCard,
  type DeviceConsentCardProps,
  type DeviceConsentMutation,
} from './screens/pending-consent/device-consent-card.tsx'
export {
  DeviceCodeEntryForm,
  type DeviceCodeEntryFormProps,
} from './screens/device/device-code-entry-form.tsx'

// The session widening's card, for a surface that sends the decision on its own
// session: the authorization server's widening page
// (`apps/host/wildflower-server/authorization-server-web`).
export {
  SessionWideningCard,
  type SessionWideningCardProps,
  type SessionWideningMutation,
} from './screens/pending-consent/session-widening-card.tsx'

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
