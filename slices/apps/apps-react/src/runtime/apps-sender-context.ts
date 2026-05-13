import type AppsBridge from 'apps-core/bridge'
import type { Effect } from 'effect'
import type { Message } from 'effect-messaging-core'
import { createContext } from 'react'

/**
 * Decoded union of every Web→Host AppsBridge message — the universe of
 * messages the apps SPA can send out. Derived from the bridge's own
 * `Web.OutboundSchemas` so adding (or renaming) a web→host tag in
 * `apps-core/bridge.ts` flows through to every sender call site
 * without an intermediate restatement.
 */
type AppsOutboundMessage = Message.Of<(typeof AppsBridge)['Web']['OutboundSchemas']>

/**
 * Send an AppsBridge Web→Host message. Returns an Effect that the
 * caller runs via `Effect.runPromise` (or similar). Provided by the app
 * from its `BridgeTransport`'s `sendMessage`.
 *
 * Typed in terms of the bridge's outbound schemas so the slice and the
 * bridge wire-contract can't drift.
 */
type AppsSender = (message: AppsOutboundMessage) => Effect.Effect<void>

const AppsSenderContext = createContext<AppsSender | null>(null)

export { AppsSenderContext }
export type { AppsOutboundMessage, AppsSender }
