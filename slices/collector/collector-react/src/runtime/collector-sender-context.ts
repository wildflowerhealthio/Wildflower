import type { Effect } from 'effect'
import { createContext } from 'react'

/** A `_tag` of the CollectorBridge's Web→Host messages collector-react can send. */
type CollectorWebOutboundTag =
  | 'RequestSniffableWebView'
  | 'CancelSnifferRequest'
  | 'SniffingComplete'

/**
 * Send a CollectorBridge Web→Host message. Returns an Effect that the
 * caller runs via `Effect.runPromise` (or similar). Provided by the app
 * from its `BridgeTransport`'s `sendMessage`.
 *
 * Typed loosely on the message shape so the slice doesn't have to
 * re-state every bridge message inline — call sites construct the
 * tagged message inline and the bridge's runtime dispatch checks `_tag`.
 */
type CollectorSender = (message: {
  readonly _tag: CollectorWebOutboundTag
  readonly [key: string]: unknown
}) => Effect.Effect<void>

const CollectorSenderContext = createContext<CollectorSender | null>(null)

export { CollectorSenderContext }
export type { CollectorSender, CollectorWebOutboundTag }
