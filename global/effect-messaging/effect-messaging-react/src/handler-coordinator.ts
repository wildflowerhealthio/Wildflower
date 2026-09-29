import type { Effect } from 'effect'
import type {
  Bridge,
  BridgeTransport,
  HandlerCoordinator,
  MessageHandler,
} from 'effect-messaging-core'
import { createContext, useMemo } from 'react'
import { useContextOrThrow } from 'react-kitchen-sink'

const HandlerCoordinatorContext = createContext<HandlerCoordinator | null>(null)
HandlerCoordinatorContext.displayName = 'HandlerCoordinatorContext'

/**
 * Read the surrounding {@link HandlerCoordinator}.
 *
 * @remarks
 * Slices typically don't call this directly — they instantiate
 * {@link makeUseSliceRegister} with their own bridge for a narrower,
 * already-bound `register` / `unregister` API. Components that need the
 * full coordinator (e.g. an app shell registering for multiple bridges)
 * can read it here. Requires a `HandlerCoordinatorContext.Provider`
 * above.
 */
const useHandlerCoordinator = (): HandlerCoordinator => useContextOrThrow(HandlerCoordinatorContext)

/**
 * Per-bridge register/unregister accessor — the typed view a slice
 * binds once for its own bridge. The returned hook reads the surrounding
 * {@link HandlerCoordinator} and pre-applies `bridge`, so callers see a
 * `(handlers) => Effect` pair typed precisely to `B['HostToWeb']`.
 *
 * Intended pattern: each slice instantiates this at module scope with
 * its own bridge and exports the resulting hook.
 *
 * ```ts
 * const useCollectorRegister = makeUseSliceRegister(CollectorBridge)
 * // …in a component:
 * const { register, unregister } = useCollectorRegister()
 * Effect.runFork(register(handlers))
 * ```
 */
const makeUseSliceRegister = <const B extends Bridge.AnyBridge>(
  bridge: B
): (() => SliceRegister<B>) => {
  return (): SliceRegister<B> => {
    const coordinator = useHandlerCoordinator()
    return useMemo<SliceRegister<B>>(
      () => ({
        register: (handlers) => coordinator.register(bridge, handlers),
        unregister: (handlers) => coordinator.unregister(bridge, handlers),
      }),
      [coordinator]
    )
  }
}

/** The shape returned by a hook built via {@link makeUseSliceRegister}. */
interface SliceRegister<B extends Bridge.AnyBridge> {
  readonly register: (
    handlers: MessageHandler.HandlersFor<B['HostToWeb']>
  ) => Effect.Effect<void, BridgeTransport.DuplicateTagError>
  readonly unregister: (
    handlers: MessageHandler.HandlersFor<B['HostToWeb']>
  ) => Effect.Effect<void, BridgeTransport.DuplicateTagError>
}

export { HandlerCoordinatorContext, makeUseSliceRegister, useHandlerCoordinator }
// `BridgeHandlerRecord` and `HandlerCoordinator` now live in
// effect-messaging-core (the contract is platform-agnostic); re-exported
// here so existing React consumers keep importing them from this module.
export type { BridgeHandlerRecord, HandlerCoordinator } from 'effect-messaging-core'
export type { SliceRegister }
