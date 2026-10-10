import type { Message } from '@wildflowerhealthio/effect-messaging-core'
import type { BackgroundServerServiceBridge } from '@wildflowerhealthio/wildflower-server-core-js'
import type { Effect } from 'effect'
import { createContext } from 'react'

/**
 * Decoded union of every Web→Host `BackgroundServerServiceBridge` message —
 * today just `RestartServer`.
 *
 * @remarks
 * Derived from the bridge's own `WebToHost` record, so a tag added or renamed
 * in `wildflower-server-core-js/src/bridge.ts` reaches every sender call
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
