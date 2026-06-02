import { Effect, Record } from 'effect'
import type { Bridge, BridgeTransport, MessageHandler } from 'effect-messaging-core'
import { HandlerHelpers } from 'effect-messaging-core'
import { createContext } from 'react'
import { useContextOrThrow } from 'react-kitchen-sink'

/**
 * Any bridge's inbound handler record, accepted structurally for internal
 * storage. The `never` parameter widens to any specific message type via
 * contravariance.
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
 *
 * Generic over the page's `Bridges` tuple and the receiving `InDir` so
 * `register` / `unregister` accept only a bridge from that tuple and a
 * handler record precisely typed against that bridge's inbound schema.
 * Slices narrow `Bridges` to their own bridge at the call site — see
 * {@link useHandlerCoordinator}.
 */
interface HandlerCoordinator<
  Bridges extends ReadonlyArray<Bridge.AnyBridge>,
  InDir extends Bridge.Direction,
> {
  /**
   * Install `handlers` as `bridge`'s active record (last writer wins) and
   * re-register. Fails with a `DuplicateTagError` if the combined record
   * would collide on an inbound tag.
   */
  readonly register: <B extends Bridges[number]>(
    bridge: B,
    handlers: MessageHandler.HandlersFor<B[InDir]>
  ) => Effect.Effect<void, BridgeTransport.DuplicateTagError>
  /**
   * Remove `handlers` if it's still the active record for `bridge`
   * (set-if-equal), then re-register. Same failure channel as
   * {@link HandlerCoordinator.register}, since re-registering is what
   * actually surfaces a collision.
   */
  readonly unregister: <B extends Bridges[number]>(
    bridge: B,
    handlers: MessageHandler.HandlersFor<B[InDir]>
  ) => Effect.Effect<void, BridgeTransport.DuplicateTagError>
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
    registerHandlers: (
      handlers: Bridge.HandlersByBridge<Bridges, InDir>
    ) => Effect.Effect<void, BridgeTransport.DuplicateTagError>
  ) => HandlerCoordinator<Bridges, InDir>
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
      (_schema, tag) => () => HandlerHelpers.warnAboutDroppedTag(bridge.name, tag)
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
    registerHandlers: (
      handlers: Bridge.HandlersByBridge<Bridges, InDir>
    ) => Effect.Effect<void, BridgeTransport.DuplicateTagError>
  ): HandlerCoordinator<Bridges, InDir> => {
    const apply: Effect.Effect<void, BridgeTransport.DuplicateTagError> = Effect.suspend(() =>
      registerHandlers(recompose())
    )

    const register = <B extends Bridges[number]>(
      bridge: B,
      handlers: MessageHandler.HandlersFor<B[InDir]>
    ): Effect.Effect<void, BridgeTransport.DuplicateTagError> =>
      Effect.suspend(() => {
        // The active map is string-keyed; the typed handler record erases
        // to the structural `BridgeHandlerRecord` for storage and is
        // re-narrowed in `recompose`.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        active.set(bridge.name, handlers as unknown as BridgeHandlerRecord)
        return apply
      })

    const unregister = <B extends Bridges[number]>(
      bridge: B,
      handlers: MessageHandler.HandlersFor<B[InDir]>
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

// The context erases the precise `Bridges` / `InDir` parameters so a
// single React context node serves every slice. Consumers narrow at the
// `useHandlerCoordinator` call site below — each slice declares only the
// bridge(s) it cares about, and the coordinator's generic `register` /
// `unregister` enforce that the handler record matches the bridge's
// inbound schema.
const HandlerCoordinatorContext = createContext<HandlerCoordinator<
  ReadonlyArray<Bridge.AnyBridge>,
  Bridge.Direction
> | null>(null)

/**
 * Read the surrounding {@link HandlerCoordinator}, narrowed to the
 * caller's bridge tuple and inbound direction.
 *
 * @remarks
 * Slices register their real inbound handler record through this — on
 * mount, when a scoped activity starts, or per-request — and unregister
 * (set-if-equal) when it ends, by `Effect.runFork`-ing the returned
 * `register` / `unregister` Effects. A bridge with nothing registered
 * falls back to the coordinator's drop-all. Requires a
 * `HandlerCoordinatorContext.Provider` above.
 *
 * Pass the slice's bridge tuple as the type argument so the returned
 * `register` / `unregister` are typed against that bridge's inbound
 * schema:
 *
 * ```ts
 * const coordinator = useHandlerCoordinator<readonly [typeof CollectorBridge]>()
 * coordinator.register(CollectorBridge, collectorHandlers) // typed
 * ```
 *
 * The runtime coordinator stores by bridge name, so a narrower view at
 * the call site is sound.
 */
const useHandlerCoordinator = <
  const Bridges extends ReadonlyArray<Bridge.AnyBridge>,
  const InDir extends Bridge.Direction = 'HostToWeb',
>(): HandlerCoordinator<Bridges, InDir> =>
  // The runtime coordinator is bridge-name-keyed and direction-agnostic;
  // each consumer narrows to its own bridge tuple at the call site.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  useContextOrThrow(HandlerCoordinatorContext) as unknown as HandlerCoordinator<Bridges, InDir>

export { HandlerCoordinatorContext, makeHandlerCoordinator, useHandlerCoordinator }
export type { BridgeHandlerRecord, HandlerCoordinator, UnconnectedCoordinator }
