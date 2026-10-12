import type { Message } from '@wildflowerhealthio/effect-messaging-core'
import type { RecorderBridge } from '@wildflowerhealthio/recorder-core-js'
import type { Effect } from 'effect'
import { createContext } from 'react'

/**
 * Decoded union of every Web→Host `RecorderBridge` message: `Open`,
 * `SniffingComplete` and `SaveHar`.
 *
 * @remarks
 * Derived from the bridge's own `WebToHost` record, so a tag added or renamed
 * in `recorder-core-js/src/bridge.ts` flows through to every sender call site
 * without an intermediate restatement.
 */
type RecorderOutboundMessage = Message.Of<RecorderBridge['WebToHost']>

/**
 * Send a `RecorderBridge` Web→Host message, as an Effect the caller runs.
 *
 * @remarks
 * Provided by the app from its bridge transport's `sendMessage`. Typed in terms of the bridge's own
 * outbound schemas so the slice and the wire contract cannot drift.
 */
type RecorderSender = (message: RecorderOutboundMessage) => Effect.Effect<void>

const RecorderSenderContext = createContext<RecorderSender | null>(null)
RecorderSenderContext.displayName = 'RecorderSenderContext'

export { RecorderSenderContext }
export type { RecorderOutboundMessage, RecorderSender }
