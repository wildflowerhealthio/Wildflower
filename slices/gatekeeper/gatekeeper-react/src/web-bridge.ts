import { Effect, SubscriptionRef } from 'effect'
import { GatekeeperBridge } from 'gatekeeper-core/bridge'
import { authTokenRef, waitForHostTokenRef } from './client/token-storage.ts'

/**
 * Web-side {@link GatekeeperBridge} `ReceiverLayer`:
 *
 * - `AuthTokenIssued`: writes the bearer token straight into
 *   {@link authTokenRef}; the ref's changes-stream subscriber persists
 *   to localStorage. The empty-string guard drops the bridge's empty
 *   sentinel without rotating the ref.
 * - `WaitForToken`: flips {@link waitForHostTokenRef}; the auth gate
 *   uses this to suppress the device-flow fallback while a host token
 *   is pending.
 */
const gatekeeperWebReceiverLayer = GatekeeperBridge.Web.ReceiverLayer({
  AuthTokenIssued: ({ token }) =>
    token !== '' ? SubscriptionRef.set(authTokenRef, token) : Effect.void,
  WaitForToken: () => SubscriptionRef.set(waitForHostTokenRef, true),
})

export { gatekeeperWebReceiverLayer }
