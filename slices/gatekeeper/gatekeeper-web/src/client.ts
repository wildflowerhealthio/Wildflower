/**
 * Barrel re-export for the `client/` module. Split into:
 *   - `client/token-storage.ts` — bearer-token read/write/subscribe
 *   - `client/session-layer.ts` — runtime layer + bearer-header transform
 *   - `client/session.ts`       — authenticated/unauthenticated factories
 *
 * Consumers usually want either the session factories or the token
 * helpers; the typed `GatekeeperClient` service tag itself lives in
 * `gatekeeper-core/http-api-definition` so adapters across web/expo
 * agree on the contract.
 */

export { setBearerToken, type SessionEnv, type SessionRuntime } from './client/session-layer.ts'
export {
  makeAuthenticatedSession,
  makeUnauthenticatedSession,
  type AuthenticatedSession,
  type UnauthenticatedSession,
} from './client/session.ts'
export { TOKEN_STORAGE_KEY, readToken, subscribeToken, writeToken } from './client/token-storage.ts'
