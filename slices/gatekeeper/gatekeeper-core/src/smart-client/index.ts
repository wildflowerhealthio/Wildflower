/**
 * The browser side of the SMART standalone launch `gatekeeper-rust` serves,
 * shared by every static Wildflower page that signs in to a reader-chosen
 * server — see "The SMART standalone-launch client" in the package README for
 * the shape of the flow, what the app supplies, and why this is not the
 * fhirclient-based launch in `slices/emr/fhir-r4-react/src/smart/*`.
 */

export {
  AuthorizationRejected,
  authorizationRedirectOutcome,
  authorizationRequestUrl,
  fhirAudienceFor,
  isAuthorizationResponse,
  parsePendingAuthorization,
  parseTokenResponse,
  searchWithoutAuthorizationResponse,
  serializePendingAuthorization,
  TokenExchangeFailed,
  tokenRequestBody,
} from './authorization-flow.ts'
export type {
  AccessGrant,
  AuthorizationRequestParameters,
  PendingAuthorization,
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
  searchWithServerUrl,
  SERVER_QUERY_PARAM,
  serverUrlFromSearch,
} from './server-target.ts'

export { CLIENT_BASE_URL_PARAM, pageOnClientCopy, parseClientBaseUrl } from '../client-base-url.ts'
export { redirectUriForPage, redirectUriForRoute } from './redirect-target.ts'

export { browserSignInEnvironment } from './browser-environment.ts'
export type { ClientRegistration, SignInPage } from './browser-environment.ts'

export {
  STANDALONE_LAUNCH_SCOPES,
  standaloneLaunchScopeParameter,
} from './standalone-launch-scopes.ts'

export { beginSignIn, completeSignIn, PendingRequestUnusable } from './sign-in.ts'
export type { PendingStore, Session, SignInEnvironment, SignInError } from './sign-in.ts'

export {
  discoverSmartEndpoints,
  DiscoveryFailed,
  insecureTargetReason,
  isLoopbackHost,
  SMART_CONFIGURATION_PATH,
  smartConfigurationUrl,
  smartEndpointsFrom,
  usableEndpointUrl,
} from './smart-discovery.ts'
export type { SmartEndpoints } from './smart-discovery.ts'
