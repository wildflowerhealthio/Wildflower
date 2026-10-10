/**
 * The browser side of the SMART sign-in `gatekeeper-rust` serves — a standalone
 * launch, or an EHR launch when the app was opened with one — shared by every
 * static Wildflower page that signs in to a reader-chosen server. See "The
 * SMART sign-in client" in the package README for the shape of the flow, what
 * the app supplies, and why this is not the fhirclient-based launch in
 * `slices/fhir/fhir-r4-react/src/smart/*`.
 */

export {
  AuthorizationRejected,
  authorizationRedirectOutcome,
  authorizationRequestUrl,
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
  searchAfterArrivingLaunch,
  searchWithServerUrl,
  SERVER_QUERY_PARAM,
  serverUrlNamedBy,
  serverUrlFromSearch,
} from './server-target.ts'

export { redirectUriForPage, redirectUriForRoute } from './redirect-target.ts'

export { arrivingSmartLaunchFrom } from './arriving-launch.ts'
export type { ArrivingSmartLaunch } from './arriving-launch.ts'

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
  PlainSmartServer,
  SMART_CONFIGURATION_PATH,
  smartConfigurationUrl,
  smartEndpointsFrom,
  usableEndpointUrl,
  WildflowerServer,
} from './smart-discovery.ts'
export type { SmartEndpoints, SmartIssuer, SmartServer } from './smart-discovery.ts'
