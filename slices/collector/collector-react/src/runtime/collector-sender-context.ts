import type CollectorBridge from 'collector-fundamentals/bridge'
import type { Effect } from 'effect'
import type { Message } from 'effect-messaging-core'
import { createContext } from 'react'

/**
 * Decoded union of every Web→Host CollectorBridge message — the
 * universe of messages the collector SPA can send out. Derived from
 * the bridge's own `Web.OutboundSchemas` so adding (or renaming) a
 * web→host tag in `collector-fundamentals/bridge.ts` flows through to
 * every sender call site without an intermediate restatement.
 */
type CollectorOutboundMessage = Message.Of<(typeof CollectorBridge)['Web']['OutboundSchemas']>

/**
 * Send a CollectorBridge Web→Host message. Returns an Effect that the
 * caller runs via `Effect.runPromise` (or similar). Provided by the
 * app from its `BridgeTransport`'s `sendMessage`.
 *
 * Typed in terms of the bridge's outbound schemas so the slice and the
 * bridge wire-contract can't drift.
 */
type CollectorSender = (message: CollectorOutboundMessage) => Effect.Effect<void>

const CollectorSenderContext = createContext<CollectorSender | null>(null)

export { CollectorSenderContext }
export type { CollectorOutboundMessage, CollectorSender }
