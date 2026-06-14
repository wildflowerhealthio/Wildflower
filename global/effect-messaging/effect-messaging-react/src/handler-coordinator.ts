import { Effect, Record } from 'effect'
import {
  type Bridge,
  type BridgeHandlerRecord,
  type BridgeTransport,
  type HandlerCoordinator,
  HandlerHelpers,
  type MessageHandler,
} from 'effect-messaging-core'
import { createContext, useMemo } from 'react'
import { useContextOrThrow } from 'react-kitchen-sink'

/** The boot-composed handler tuple plus a way to bind the live transport. */
interface UnconnectedCoordinator<Bridges extends ReadonlyArray<Bridge.AnyBridge>> {
  /**
   * The seed-composed handler tuple to pass as the transport's *initial*
   * `handlers` — boot-stable records in place, every other bridge a
   * drop-all. Lets the transport be built before {@link connect} binds
   * its `registerHandlers` back.
   */
  readonly initialHandlers: Bridge.HandlersByBridge<Bridges, 'HostToWeb'>
  /** Bind the live transport's `registerHandlers` and start coordinating. */
  readonly connect: (
    registerHandlers: (
      handlers: Bridge.HandlersByBridge<Bridges, 'HostToWeb'>
    ) => Effect.Effect<void, BridgeTransport.DuplicateTagError>
  ) => HandlerCoordinator
}

/**
 * Build a {@link HandlerCoordinator} for a bridge tuple.
 *
 * @remarks
 * Two-phase to resolve the boot chicken-and-egg: the transport needs a
 * complete initial handler tuple, but the coordinator needs the
 * transport's `registerHandlers`. So the factory first exposes
 * {@link UnconnectedCoordinator.initialHandlers} (built from `initial` +
 * drop-all), the caller builds the transport with it, then
 * {@link UnconnectedCoordinator.connect} binds `registerHandlers`.
 *
 * `Bridges` is internal-only — it parameterises `initialHandlers` and
 * the `registerHandlers` binding (both need the tuple shape) but the
 * returned coordinator's outward API is the bridge-wide
 * {@link HandlerCoordinator}, so consumers (slice hooks, the React
 * context) don't have to know the app's full tuple.
 *
 * @param bridges - the wired bridge tuple; its order fixes tuple positions.
 * @param initial - boot-stable records keyed by bridge name (e.g. navigation,
 *   gatekeeper). Bridges absent here start as drop-all until a slice registers.
 */
const makeHandlerCoordinator = <const Bridges extends ReadonlyArray<Bridge.AnyBridge>>(config: {
  readonly bridges: Bridges
  readonly initial: Readonly<Record<string, BridgeHandlerRecord>>
}): UnconnectedCoordinator<Bridges> => {
  const active = new Map<string, BridgeHandlerRecord>(Object.entries(config.initial))

  // A complete record for a bridge with no installed handler: every
  // inbound tag warns-and-drops (the transport requires complete records).
  const dropAll = (bridge: Bridge.AnyBridge): BridgeHandlerRecord =>
    Record.map(
      bridge['HostToWeb'],
      (_schema, tag) => () => HandlerHelpers.warnAboutDroppedTag(bridge.name, tag)
    )

  const recompose = (): Bridge.HandlersByBridge<Bridges, 'HostToWeb'> => {
    const tuple = config.bridges.map((bridge) => active.get(bridge.name) ?? dropAll(bridge))
    // The active map is string-keyed, so the recomposed tuple's element
    // types erase to `AnyHandlers`; re-impose the positional
    // `HandlersByBridge` shape. Sound because every slot is either a
    // caller-supplied record for that bridge or a drop-all generated over
    // that same bridge's inbound tags — the same erasure the transport's
    // own registry performs internally.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return tuple as unknown as Bridge.HandlersByBridge<Bridges, 'HostToWeb'>
  }

  const connect = (
    registerHandlers: (
      handlers: Bridge.HandlersByBridge<Bridges, 'HostToWeb'>
    ) => Effect.Effect<void, BridgeTransport.DuplicateTagError>
  ): HandlerCoordinator => {
    const apply: Effect.Effect<void, BridgeTransport.DuplicateTagError> = Effect.suspend(() =>
      registerHandlers(recompose())
    )

    const register = <const B extends Bridge.AnyBridge>(
      bridge: B,
      handlers: MessageHandler.HandlersFor<B['HostToWeb']>
    ): Effect.Effect<void, BridgeTransport.DuplicateTagError> =>
      Effect.suspend(() => {
        // The active map is string-keyed; the typed handler record erases
        // to the structural `BridgeHandlerRecord` for storage and is
        // re-narrowed in `recompose`.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        active.set(bridge.name, handlers as unknown as BridgeHandlerRecord)
        return apply
      })

    const unregister = <const B extends Bridge.AnyBridge>(
      bridge: B,
      handlers: MessageHandler.HandlersFor<B['HostToWeb']>
    ): Effect.Effect<void, BridgeTransport.DuplicateTagError> =>
      Effect.suspend(() => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        if (active.get(bridge.name) === (handlers as unknown as BridgeHandlerRecord)) {
          active.delete(bridge.name)
        }
        return apply
      })

    return { register, unregister }
  }

  return { initialHandlers: recompose(), connect }
}

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

export {
  HandlerCoordinatorContext,
  makeHandlerCoordinator,
  makeUseSliceRegister,
  useHandlerCoordinator,
}
// `BridgeHandlerRecord` and `HandlerCoordinator` now live in
// effect-messaging-core (the contract is platform-agnostic); re-exported
// here so existing React consumers keep importing them from this module.
export type { BridgeHandlerRecord, HandlerCoordinator } from 'effect-messaging-core'
export type { SliceRegister, UnconnectedCoordinator }
