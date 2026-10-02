import type { BackgroundServerServiceBridge } from 'background-server-service-core'
import type { Effect } from 'effect'
import type { Message } from 'effect-messaging-core'
import { createContext } from 'react'

/**
 * Decoded union of every Web→Host `BackgroundServerServiceBridge` message —
 * today just `RestartServer`.
 *
 * @remarks
 * Derived from the bridge's own `WebToHost` record, so a tag added or renamed
 * in `background-server-service-core/src/bridge.ts` reaches every sender call
 * site without a restatement.
 */
type BackgroundServerServiceOutboundMessage = Message.Of<BackgroundServerServiceBridge['WebToHost']>

/**
 * Send a `BackgroundServerServiceBridge` Web→Host message, as an Effect the
 * caller runs.
 *
 * @remarks
 * Provided by the app from its transport's `sendMessage` (see the app's
 * `BackgroundServerServiceSenderForwarder`).
 */
type BackgroundServerServiceSender = (
  message: BackgroundServerServiceOutboundMessage
) => Effect.Effect<void>

const BackgroundServerServiceSenderContext = createContext<BackgroundServerServiceSender | null>(
  null
)
BackgroundServerServiceSenderContext.displayName = 'BackgroundServerServiceSenderContext'

export { BackgroundServerServiceSenderContext }
export type { BackgroundServerServiceOutboundMessage, BackgroundServerServiceSender }
