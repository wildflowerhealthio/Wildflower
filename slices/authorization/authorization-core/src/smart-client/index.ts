/**
 * The browser side of the SMART sign-in `authorization-server-rust` serves — a standalone
 * launch, or an EHR launch when the app was opened with one — shared by every
 * static Wildflower page that signs in to a reader-chosen server, the SMART
 * apps on `fhir-r4-react/smart` included. See "The SMART sign-in client" in the
 * package README for the shape of the flow and what the app supplies.
 */

export {
  AuthorizationRejected,
  authorizationRedirectOutcome,
  authorizationRequestUrl,
  isAuthorizationResponse,
  parseRetainedSignInRequest,
  parseTokenResponse,
  searchWithoutAuthorizationResponse,
  serializeRetainedSignInRequest,
  TokenExchangeFailed,
  tokenRequestBody,
} from './authorization-flow.ts'
export type {
  AccessGrant,
  AuthorizationRequestParameters,
  RetainedSignInRequest,
  RedeemableCode,
} from './authorization-flow.ts'

export {
  base64UrlEncode,
  codeChallengeS256,
  createCodeVerifier,
  createState,
  PkceUnavailable,
  randomBase64Url,
} from './pkce.ts'
export type { DigestSource, RandomBytesSource } from './pkce.ts'

export {
  normalizeServerUrl,
  searchAfterArrivingLaunch,
  searchWithServerUrl,
  SERVER_QUERY_PARAM,
  serverUrlFromSearch,
} from './server-target.ts'

export { redirectUriForPage, redirectUriForRoute } from './redirect-target.ts'

export { arrivingSmartLaunchFrom, SMART_LAUNCH_PARAMS } from './arriving-launch.ts'
export type { ArrivingSmartLaunch } from './arriving-launch.ts'

export { BrowserSignIn } from './browser-sign-in.ts'
export type { SignInWindow } from './browser-sign-in.ts'

export {
  memoryBackedRetainedRequestStore,
  retainedRequestUnusableFrom,
  RetainedSignInRequestStore,
  sessionStorageBackedRetainedRequestStore,
  SignInCrypto,
  SignInPage,
} from './sign-in-services.ts'
export type {
  RetainedRequestStorage,
  RetainedRequestStoreShape,
  SignInServices,
} from './sign-in-services.ts'

export {
  STANDALONE_LAUNCH_SCOPES,
  standaloneLaunchScopeParameter,
} from './standalone-launch-scopes.ts'

export {
  beginSignIn,
  beginSignInAt,
  completeSignIn,
  forgetRetainedSignInRequest,
  retainedRequestUnrecognisedFromAnotherVersion,
  RetainedRequestUnrecognised,
  RetainedRequestUnusable,
  TokenEndpointUnreachable,
} from './sign-in.ts'
export type {
  AuthorizationRequestExtras,
  ClientRegistration,
  Session,
  SignInError,
  SignInOptions,
} from './sign-in.ts'

export {
  discoverSmartEndpoints,
  DiscoveryFailed,
  endpointUrlFrom,
  fetchSmartConfiguration,
  insecureTargetReason,
  isLoopbackHost,
  PlainSmartServer,
  SMART_CONFIGURATION_PATH,
  SmartConfigurationFetch,
  smartConfigurationUrl,
  discoveredSmartServerFrom,
  UnusableEndpointUrl,
  usableEndpointUrl,
  WILDFLOWER_SERVER_CAPABILITY,
  WildflowerServer,
} from './smart-discovery.ts'
export type { SmartEndpoints, DiscoveredSmartServer, SmartServer } from './smart-discovery.ts'
