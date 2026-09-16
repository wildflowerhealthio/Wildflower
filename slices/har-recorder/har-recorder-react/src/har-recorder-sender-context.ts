import type { Effect } from 'effect'
import type { Message } from 'effect-messaging-core'
import type { HarRecorderBridge } from 'har-recorder-core'
import { createContext } from 'react'

/**
 * Decoded union of every Web→Host `HarRecorderBridge` message — today just
 * `SaveHar`.
 *
 * @remarks
 * Derived from the bridge's own `WebToHost` record, so a tag added or renamed
 * in `har-recorder-core/src/bridge.ts` flows through to every sender call site
 * without an intermediate restatement.
 */
type HarRecorderOutboundMessage = Message.Of<HarRecorderBridge['WebToHost']>

/**
 * Send a `HarRecorderBridge` Web→Host message, as an Effect the caller runs.
 *
 * @remarks
 * Provided by the app from its `BridgeTransport`'s `sendMessage` (see the
 * app's `HarRecorderSenderForwarder`). Typed in terms of the bridge's own
 * outbound schemas so the slice and the wire contract cannot drift.
 */
type HarRecorderSender = (message: HarRecorderOutboundMessage) => Effect.Effect<void>

const HarRecorderSenderContext = createContext<HarRecorderSender | null>(null)
HarRecorderSenderContext.displayName = 'HarRecorderSenderContext'

export { HarRecorderSenderContext }
export type { HarRecorderOutboundMessage, HarRecorderSender }
