import type { Effect } from 'effect'
import type * as BridgeTransport from './bridge-transport.ts'
import type * as Bridge from './bridge.ts'
import type * as MessageHandler from './message-handler.ts'

/**
 * Any bridge's inbound handler record, accepted structurally for internal
 * storage. The `never` parameter widens to any specific message type via
 * contravariance.
 *
 * @remarks
 * The platform-agnostic storage shape a transport's coordinator keeps one
 * of per bridge name. Both the React (`window.postMessage`) and Tauri
 * (per-tag event) adapters erase their typed `HandlersFor` records to this
 * for name-keyed storage, then re-narrow at the dispatch site.
 */
type BridgeHandlerRecord = Readonly<Record<string, (message: never) => Effect.Effect<void>>>

/**
 * Coordinates per-bridge inbound handler records, where the transport is
 * built at boot but each slice's real handlers only exist once its subtree
 * mounts.
 *
 * @remarks
 * Holds one record per bridge name. On every change it recomposes the full
 * per-bridge tuple in `bridges` order and re-registers once (replace
 * semantics) — so slices register independently without clobbering each
 * other. A bridge with no registered record gets a generated **drop-all**
 * record (every inbound tag warns-and-drops).
 *
 * The outward `register` / `unregister` API is wide on purpose: each call's
 * `bridge` argument fixes `B`, so a slice calling
 * `coordinator.register(CollectorBridge, handlers)` gets `handlers` typed
 * precisely against `CollectorBridge['HostToWeb']` without the consumer
 * needing to pre-declare the app's `Bridges` tuple. Bridges outside the
 * app's wired tuple silently no-op, matching the runtime's name-keyed
 * reality.
 *
 * This contract is platform-agnostic — its only error channel is core's
 * {@link BridgeTransport.DuplicateTagError}. Adapters (React's
 * `makeHandlerCoordinator` + context, Tauri's transport) implement it; the
 * React-flavored hooks (`makeUseSliceRegister`, the context) live in the
 * React adapter.
 */
interface HandlerCoordinator {
  /**
   * Install `handlers` as `bridge`'s active record (last writer wins) and
   * re-register. Fails with a `DuplicateTagError` if the combined record
   * would collide on an inbound tag.
   */
  readonly register: <const B extends Bridge.AnyBridge>(
    bridge: B,
    handlers: MessageHandler.HandlersFor<B['HostToWeb']>
  ) => Effect.Effect<void, BridgeTransport.DuplicateTagError>
  /**
   * Remove `handlers` if it's still the active record for `bridge`
   * (set-if-equal), then re-register. Same failure channel as
   * {@link HandlerCoordinator.register}, since re-registering is what
   * actually surfaces a collision.
   */
  readonly unregister: <const B extends Bridge.AnyBridge>(
    bridge: B,
    handlers: MessageHandler.HandlersFor<B['HostToWeb']>
  ) => Effect.Effect<void, BridgeTransport.DuplicateTagError>
}

export type { BridgeHandlerRecord, HandlerCoordinator }
