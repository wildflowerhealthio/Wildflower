import { Effect, SubscriptionRef } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import type { GatekeeperBridge } from 'gatekeeper-core/bridge'
import { authTokenRef } from './client/token-storage.ts'

/**
 * Build the web-side {@link GatekeeperBridge} inbound handler record:
 *
 * - `AuthTokenIssued`: writes the bearer token straight into
 *   {@link authTokenRef}; the ref's changes-stream subscriber persists
 *   to localStorage. The empty-string guard drops the bridge's empty
 *   sentinel without rotating the ref.
 */
const makeGatekeeperWebHandlers = (): MessageHandler.HandlersFor<
  (typeof GatekeeperBridge)['HostToWeb']
> => ({
  AuthTokenIssued: ({ token }) =>
    token !== '' ? SubscriptionRef.set(authTokenRef, token) : Effect.void,
})

export { makeGatekeeperWebHandlers }
