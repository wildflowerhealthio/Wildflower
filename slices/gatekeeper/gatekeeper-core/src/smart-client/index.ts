/**
 * The browser side of the SMART standalone launch `gatekeeper-rust` serves.
 *
 * A static Wildflower page — `apps/wildflower-server-docs` today, the hosted
 * owner UI next — points itself at whichever server the reader runs
 * (`server-target.ts`), asks that server how to sign in
 * (`smart-discovery.ts`), mints a PKCE pair (`pkce.ts`), leaves for
 * `/oauth/authorize` and picks the flow back up on the way home
 * (`authorization-flow.ts`, `sign-in.ts`).
 *
 * Everything here is pure or takes its impure edges — `fetch`, Web Crypto,
 * `sessionStorage` — as an injected `SignInEnvironment`, so the package stays
 * inside the `-core` layering rule and the whole flow is drivable from a unit
 * test. Nothing app-specific lives here: the client id, the scopes, the
 * redirect URI and the `sessionStorage` key are the app's to supply.
 *
 * This is **not** the fhirclient-based launch in
 * `slices/emr/fhir-r4-react/src/smart/*`, which the self-hosted React apps use.
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

export { beginSignIn, completeSignIn, PendingRequestUnusable } from './sign-in.ts'
export type { PendingStore, Session, SignInEnvironment, SignInError } from './sign-in.ts'

export {
  discoverSmartEndpoints,
  DiscoveryFailed,
  SMART_CONFIGURATION_PATH,
  smartConfigurationUrl,
  smartEndpointsFrom,
  usableEndpointUrl,
} from './smart-discovery.ts'
export type { SmartEndpoints } from './smart-discovery.ts'
