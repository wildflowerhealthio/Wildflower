/**
 * Module-scoped flag indicating the embedding host has committed to
 * delivering an `AuthTokenIssued` via the gatekeeper bridge. Initialized
 * `false`; flipped to `true` by `gatekeeperWebReceiverLayer` when a
 * `WaitForToken` bridge message arrives.
 *
 * `WaitForToken` rides URL params, and `TransportProvider` blocks the
 * descendant tree until `transport.flushed` resolves — so subscribers
 * see the post-handshake value on first read. The auth gate consults
 * this to decide whether to render a neutral loader (host present) vs.
 * the device-flow UI (truly standalone) when no token is present yet.
 */

import { Effect, SubscriptionRef } from 'effect'

const waitForHostTokenRef: SubscriptionRef.SubscriptionRef<boolean> = Effect.runSync(
  SubscriptionRef.make(false)
)

export { waitForHostTokenRef }
