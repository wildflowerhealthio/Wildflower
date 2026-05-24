import { Effect, SubscriptionRef } from 'effect'
import GatekeeperBridge from 'gatekeeper-core/bridge'
import { writeToken } from './client/token-storage.ts'
import { waitForHostTokenRef } from './client/wait-for-host-token-ref.ts'

/**
 * Web-side {@link GatekeeperBridge} `ReceiverLayer`:
 *
 * - `AuthTokenIssued`: writes the bearer token via `writeToken`, which
 *   routes to `authTokenRef` and localStorage.
 * - `WaitForToken`: flips `waitForHostTokenRef`; the auth gate uses
 *   this to suppress the device-flow fallback while a host token is
 *   pending.
 */
const gatekeeperWebReceiverLayer = GatekeeperBridge.Web.ReceiverLayer({
  AuthTokenIssued: ({ token }) =>
    Effect.sync(() => {
      if (token !== '') writeToken(token)
    }),
  WaitForToken: () => SubscriptionRef.set(waitForHostTokenRef, true),
})

export { gatekeeperWebReceiverLayer }
