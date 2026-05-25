import type { Layer } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import GatekeeperBridge from 'gatekeeper-core/bridge'

/**
 * Build the host-side `ReceiverLayer` for {@link GatekeeperBridge}.
 *
 * GatekeeperBridge has no web→host messages today; the host stays a
 * silent participant in the bridge tuple so the transport handshake
 * lights up, but no payloads need handling. The helper exists so app
 * shells don't need to know the empty-handler shape — they hand the
 * returned Layer to `WithTransport` alongside the other bridges'
 * receivers.
 */
const ReceiverLayer = (): Layer.Layer<MessageHandler.TagId<'Gatekeeper', 'Host'>> =>
  GatekeeperBridge.Host.ReceiverLayer({})

export { ReceiverLayer }
