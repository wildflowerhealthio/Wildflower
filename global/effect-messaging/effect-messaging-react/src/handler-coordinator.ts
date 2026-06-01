import { Effect, Record } from 'effect'
import type { Bridge } from 'effect-messaging-core'
import { HandlerHelpers } from 'effect-messaging-core'
import { createContext } from 'react'
import { useContextOrThrow } from 'react-kitchen-sink'

/**
 * Any bridge's inbound handler record, accepted structurally at the
 * coordinator boundary. The `never` parameter is the device that lets a
 * concrete `MessageHandler.HandlersFor<…>` (whose handlers take specific
 * message types) be passed without a cast — each specific message type is
 * a supertype of `never`, so the assignment holds. The coordinator only
 * stores and re-emits these records; the transport re-narrows them when it
 * dispatches.
 */
type BridgeHandlerRecord = Readonly<Record<string, (message: never) => Effect.Effect<void>>>

/**
 * Coordinates per-bridge inbound handler records on the web side, where
 * the transport is built at boot but each slice's real handlers only
 * exist once its React subtree mounts.
 *
 * @remarks
 * Holds one record per bridge name. On every change it recomposes the
 * full per-bridge tuple in `bridges` order and calls the transport's
 * `registerHandlers` once (replace semantics) — so slices register
 * independently without clobbering each other. A bridge with no
 * registered record gets a generated **drop-all** record (every inbound
 * tag warns-and-drops), exactly the behavior the old per-slice forwarder
 * cells provided before a real handler was installed.
 */
interface HandlerCoordinator {
  /** Install `handlers` as bridge `bridgeName`'s active record (last writer wins) and re-register. */
  readonly register: (bridgeName: string, handlers: BridgeHandlerRecord) => Effect.Effect<void>
  /** Remove `handlers` if it's still the active record for `bridgeName` (set-if-equal), then re-register. */
  readonly unregister: (bridgeName: string, handlers: BridgeHandlerRecord) => Effect.Effect<void>
}

/** The boot-composed handler tuple plus a way to bind the live transport. */
interface UnconnectedCoordinator<
  Bridges extends ReadonlyArray<Bridge.AnyBridge>,
  InDir extends Bridge.Direction,
> {
  /**
   * The seed-composed handler tuple to pass as the transport's *initial*
   * `handlers` — boot-stable records in place, every other bridge a
   * drop-all. Lets the transport be built before {@link connect} binds
   * its `registerHandlers` back.
   */
  readonly initialHandlers: Bridge.HandlersByBridge<Bridges, InDir>
  /** Bind the live transport's `registerHandlers` and start coordinating. */
  readonly connect: (
    registerHandlers: (handlers: Bridge.HandlersByBridge<Bridges, InDir>) => Effect.Effect<void>
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
 * @param bridges - the wired bridge tuple; its order fixes tuple positions.
 * @param inboundDirection - the receiving direction (`'HostToWeb'` on the web).
 * @param initial - boot-stable records keyed by bridge name (e.g. navigation,
 *   gatekeeper). Bridges absent here start as drop-all until a slice registers.
 */
const makeHandlerCoordinator = <
  const Bridges extends ReadonlyArray<Bridge.AnyBridge>,
  const InDir extends Bridge.Direction,
>(config: {
  readonly bridges: Bridges
  readonly inboundDirection: InDir
  readonly initial: Readonly<Record<string, BridgeHandlerRecord>>
}): UnconnectedCoordinator<Bridges, InDir> => {
  const active = new Map<string, BridgeHandlerRecord>(Object.entries(config.initial))

  // A complete record for a bridge with no installed handler: every
  // inbound tag warns-and-drops (the transport requires complete records).
  const dropAll = (bridge: Bridge.AnyBridge): BridgeHandlerRecord =>
    Record.map(
      bridge[config.inboundDirection],
      (_schema, tag) => () => HandlerHelpers.droppedTagWarning(bridge.name, tag)
    )

  const recompose = (): Bridge.HandlersByBridge<Bridges, InDir> => {
    const tuple = config.bridges.map((bridge) => active.get(bridge.name) ?? dropAll(bridge))
    // The active map is string-keyed, so the recomposed tuple's element
    // types erase to `AnyHandlers`; re-impose the positional
    // `HandlersByBridge` shape. Sound because every slot is either a
    // caller-supplied record for that bridge or a drop-all generated over
    // that same bridge's inbound tags — the same erasure the transport's
    // own registry performs internally.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return tuple as unknown as Bridge.HandlersByBridge<Bridges, InDir>
  }

  const connect = (
    registerHandlers: (handlers: Bridge.HandlersByBridge<Bridges, InDir>) => Effect.Effect<void>
  ): HandlerCoordinator => {
    const apply: Effect.Effect<void> = Effect.suspend(() => registerHandlers(recompose()))

    const register = (bridgeName: string, handlers: BridgeHandlerRecord): Effect.Effect<void> =>
      Effect.suspend(() => {
        active.set(bridgeName, handlers)
        return apply
      })

    const unregister = (bridgeName: string, handlers: BridgeHandlerRecord): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (active.get(bridgeName) === handlers) active.delete(bridgeName)
        return apply
      })

    return { register, unregister }
  }

  return { initialHandlers: recompose(), connect }
}

const HandlerCoordinatorContext = createContext<HandlerCoordinator | null>(null)

/**
 * Read the surrounding {@link HandlerCoordinator}.
 *
 * @remarks
 * Slices register their real inbound handler record through this — on
 * mount, when a scoped activity starts, or per-request — and unregister
 * (set-if-equal) when it ends, by `Effect.runFork`-ing the returned
 * `register` / `unregister` Effects. A bridge with nothing registered
 * falls back to the coordinator's drop-all. Requires a
 * `HandlerCoordinatorContext.Provider` above.
 */
const useHandlerCoordinator = (): HandlerCoordinator => useContextOrThrow(HandlerCoordinatorContext)

export { HandlerCoordinatorContext, makeHandlerCoordinator, useHandlerCoordinator }
export type { BridgeHandlerRecord, HandlerCoordinator, UnconnectedCoordinator }
