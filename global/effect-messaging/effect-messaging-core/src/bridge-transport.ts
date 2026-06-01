import type { Scope } from 'effect'
import { Deferred, Effect } from 'effect'
import type * as Bridge from './bridge.ts'
import { makeHandlerRegistry } from './internal/handler-registry.ts'
import { READY_RAW } from './internal/handshake-message.ts'
import { makeInboundDispatcher } from './internal/inbound-dispatcher.ts'
import { makeOutboundPump, type MessageSender } from './internal/outbound-pump.ts'
import type * as MessageHandler from './message-handler.ts'
import { TransportAdapter } from './transport-adapter.ts'

/**
 * Cross-platform bridge transport composing one or more
 * {@link Bridge.Bridge} declarations into a single Effect program.
 *
 * @remarks
 * `InDir` is the direction this transport *receives* and `OutDir` the one
 * it *sends* — the two are mirror directions, fixed by the entry point
 * ({@link makeHostTransport} receives `'WebToHost'` / sends `'HostToWeb'`;
 * {@link makeWebTransport} is the reverse).
 *
 * Two queues run behind the public surface: an **outbox** (sends are
 * offered immediately and a pump fiber drains them once the peer signals
 * `__Ready`) and an **inbox** (raw inbound strings processed in FIFO
 * order by a single dispatch fiber). Scope close shuts down both queues,
 * interrupts both fibers, and detaches platform listeners.
 */
interface BridgeTransport<
  Bridges extends ReadonlyArray<Bridge.AnyBridge>,
  InDir extends Bridge.Direction,
  OutDir extends Bridge.Direction,
> {
  /**
   * Enqueue an outbound message belonging to one of the wired bridges.
   *
   * @remarks
   * The send is buffered in the outbox and never suspends the caller.
   * A pump fiber flushes the outbox once the peer has signalled `__Ready`:
   * on the host that's when the page posts it; on the web it resolves
   * immediately (the web self-posts `__Ready` at make). The asymmetry
   * matches the lifecycle — the host is up before the web bundle loads,
   * so the web never waits on anyone.
   */
  readonly sendMessage: MessageSender<Bridges, OutDir>
  /**
   * Push one raw inbound string into the dispatch fiber. After scope
   * close the call is a no-op (the queue is shut down).
   */
  readonly enqueue: (raw: string) => Effect.Effect<void>
  /**
   * Tell the peer this side is ready to receive messages. Web posts
   * `__Ready` to the host (resolving the host's send-gating Deferred);
   * host is a no-op (the handshake is one-way). Idempotent.
   */
  readonly signalReady: Effect.Effect<void>
  /**
   * Replace the active per-bridge handler records as a single atomic set,
   * applied against the dispatch fiber's reads.
   *
   * @remarks
   * Pure — handlers are plain records, so there is no layer/resource
   * discharge and repeated calls don't accumulate. Replace semantics:
   * the supplied records become the whole active set; a tag absent from
   * the new records loses its handler (future messages for it are
   * logged-and-dropped). Throws (as a defect) on a duplicate-tag wiring
   * error, leaving the prior map in place.
   */
  readonly registerHandlers: (
    handlers: Bridge.HandlersByBridge<Bridges, InDir>
  ) => Effect.Effect<void>
}

const make = <
  const Bridges extends ReadonlyArray<Bridge.AnyBridge>,
  const InDir extends Bridge.Direction,
  const OutDir extends Bridge.Direction,
>(config: {
  readonly bridges: Bridges
  readonly handlers: Bridge.HandlersByBridge<Bridges, InDir>
  readonly inboundDirection: InDir
  readonly outboundDirection: OutDir
  /**
   * Whether this transport is the host endpoint. Drives the one-way
   * `__Ready` handshake asymmetry: the web self-queues `__Ready` (so its
   * outbox pump unblocks immediately) and posts `__Ready` to the host via
   * {@link signalReady}; the host waits to receive it and never sends one.
   */
  readonly isHost: boolean
}): Effect.Effect<BridgeTransport<Bridges, InDir, OutDir>, never, TransportAdapter | Scope.Scope> =>
  Effect.gen(function* () {
    const {
      bridges,
      handlers: initialHandlers,
      inboundDirection,
      outboundDirection,
      isHost,
    } = config
    const adapter = yield* TransportAdapter

    /**
     * Send-gating Deferred, resolved by the `__Ready` handler the registry
     * installs. The host receives `__Ready` from the web peer; the web
     * self-posts a `__Ready` (see `preDrain` below) so the same dispatch
     * path resolves the gate on both sides.
     */
    const peerReady = yield* Deferred.make<void>()
    const readyTagHandler: MessageHandler.Handler = () =>
      Deferred.succeed(peerReady, undefined).pipe(Effect.asVoid)

    const registry = yield* makeHandlerRegistry<Bridges, InDir>({
      bridges,
      initialHandlers,
      readyTagHandler,
    })
    const { enqueue } = yield* makeInboundDispatcher({
      bridges,
      inboundDirection,
      registry,
      adapter,
      // The web self-posts `__Ready` ahead of the boot URL-param drain so
      // its outbox pump unblocks immediately; the host waits to receive
      // the web's.
      preDrain: isHost ? [] : [READY_RAW],
    })
    const { sendMessage } = yield* makeOutboundPump({
      bridges,
      outboundDirection,
      adapter,
      ready: Deferred.await(peerReady),
    })

    // One-way handshake: the web posts `__Ready` to the host; the host
    // never sends one (it waits to receive the web's).
    const signalReady = isHost ? Effect.void : adapter.bareSender(READY_RAW)

    return {
      sendMessage,
      enqueue,
      signalReady,
      registerHandlers: registry.register,
    }
  })

/**
 * Build the **host** endpoint of a bridge transport: it receives
 * `'WebToHost'` messages (routed through `handlers`) and sends
 * `'HostToWeb'` messages via `sendMessage`. The host waits for the web
 * peer's `__Ready` before flushing its outbox.
 */
const makeHostTransport = <const Bridges extends ReadonlyArray<Bridge.AnyBridge>>(config: {
  readonly bridges: Bridges
  readonly handlers: Bridge.HandlersByBridge<Bridges, 'WebToHost'>
}): Effect.Effect<
  BridgeTransport<Bridges, 'WebToHost', 'HostToWeb'>,
  never,
  TransportAdapter | Scope.Scope
> =>
  make({
    bridges: config.bridges,
    handlers: config.handlers,
    inboundDirection: 'WebToHost',
    outboundDirection: 'HostToWeb',
    isHost: true,
  })

/**
 * Build the **web** endpoint of a bridge transport: it receives
 * `'HostToWeb'` messages (routed through `handlers`) and sends
 * `'WebToHost'` messages via `sendMessage`. The web self-queues `__Ready`
 * so its outbox flushes immediately, and posts `__Ready` to the host.
 */
const makeWebTransport = <const Bridges extends ReadonlyArray<Bridge.AnyBridge>>(config: {
  readonly bridges: Bridges
  readonly handlers: Bridge.HandlersByBridge<Bridges, 'HostToWeb'>
}): Effect.Effect<
  BridgeTransport<Bridges, 'HostToWeb', 'WebToHost'>,
  never,
  TransportAdapter | Scope.Scope
> =>
  make({
    bridges: config.bridges,
    handlers: config.handlers,
    inboundDirection: 'HostToWeb',
    outboundDirection: 'WebToHost',
    isHost: false,
  })

export { makeHostTransport, makeWebTransport }
export type { BridgeTransport, MessageSender }
