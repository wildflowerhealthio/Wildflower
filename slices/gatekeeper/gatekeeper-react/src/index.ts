export { gatekeeperSettingsItemsFragment } from './settings-fragments.ts'

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

export { NeedsAuthMessage } from './components/NeedsAuthMessage.tsx'

export {
  EMBEDDED_TOKEN_TIMEOUT,
  makeAwaitEmbeddedAuthReady,
  makeAwaitWebAuthReady,
  TokenTimeout,
} from './client/auth-ready.ts'

export {
  consumeUrlTokenIntoLocalStorage,
  makeEmbeddedAuthTokenStore,
  makeWebAuthTokenStore,
  TOKEN_STORAGE_KEY,
} from './client/token-storage.ts'

export {
  ActiveDeviceUserCodeProvider,
  makeActiveDeviceUserCodeStore,
  useActiveDeviceUserCode,
  type ActiveDeviceUserCodeProviderProps,
  type ActiveDeviceUserCodeStore,
} from './active-device-consent/index.ts'

export { DeviceConsentModalHost } from './screens/device-consent/device-consent-modal-host.tsx'
