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
} from './queries.ts'

export { NeedsAuthMessage } from './components/NeedsAuthMessage.tsx'

export {
  TOKEN_STORAGE_KEY,
  authTokenRef,
  waitForHostTokenRef,
  writeToken,
} from './client/token-storage.ts'
