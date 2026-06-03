import type { Scope } from 'effect'
import { Deferred, Effect } from 'effect'
import type * as Bridge from './bridge.ts'
import { DuplicateTagError } from './internal/assert-no-duplicate-tags.ts'
import { makeHandlerRegistry } from './internal/handler-registry.ts'
import { READY_RAW, READY_TAG, ReadyMessageSchema } from './internal/handshake-message.ts'
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
   * A pump fiber flushes the outbox once the send gate opens: the host
   * waits to receive the web's `__Ready`; the web's gate is open from the
   * start. The asymmetry matches the lifecycle — the host is up before the
   * web bundle loads, so the web never waits on anyone.
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
   * logged-and-dropped). Fails with a {@link DuplicateTagError} on a
   * duplicate-tag wiring error, leaving the prior map in place.
   */
  readonly registerHandlers: (
    handlers: Bridge.HandlersByBridge<Bridges, InDir>
  ) => Effect.Effect<void, DuplicateTagError>
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
   * Host-only. Fires on every `__Ready` the host receives — first page
   * load and every subsequent reload — with the freshly-built outbound
   * sender. Wired to the inbound dispatcher's `__Ready` control handler,
   * so the call lands inside the dispatch fiber after the send gate has
   * been resolved. Ignored on the web endpoint (no `__Ready` to handle).
   */
  readonly onPageReady?: (send: MessageSender<Bridges, OutDir>) => Effect.Effect<void>
}): Effect.Effect<BridgeTransport<Bridges, InDir, OutDir>, never, TransportAdapter | Scope.Scope> =>
  Effect.gen(function* () {
    const { bridges, handlers: initialHandlers, inboundDirection, outboundDirection } = config
    const adapter = yield* TransportAdapter

    // The host endpoint is the one that *receives* `'WebToHost'` — the only
    // bit the `__Ready` handshake asymmetry turns on, derived rather than
    // passed so an inconsistent triple is unrepresentable.
    const isHost = inboundDirection === 'WebToHost'

    /**
     * Send gate. The host buffers its outbox until it *receives* the web's
     * `__Ready` (which resolves `peerReady` through the normal inbound →
     * registry → handler path); the web's gate is open from the start, so
     * its sends flow without waiting on anyone. `Deferred.succeed`
     * silently no-ops on the second and subsequent `__Ready` — the
     * underlying gate is one-shot, but the reload re-fire path runs
     * through `config.onPageReady`, which the dispatcher invokes for
     * every `__Ready` (see below).
     */
    const peerReady = yield* Deferred.make<void>()
    // Forward-reference handle for `sendMessage`: the inbound dispatcher
    // is constructed (and starts forwarding) before the outbound pump
    // exists, so the `__Ready` handler — which lives in the registry the
    // dispatcher reads — has to await the sender rather than capture it
    // by value. The Deferred is resolved exactly once just after
    // `makeOutboundPump` returns. Picking a Deferred (vs a `{ current }`
    // ref) means the handler suspends cleanly until the pump is up
    // instead of having to early-return on a transient null.
    const sendMessageDeferred = yield* Deferred.make<MessageSender<Bridges, OutDir>>()
    const onPageReady = config.onPageReady
    // Per-handshake counter so the logs distinguish "first __Ready
    // after build" from "re-fire after WebView reload" at a glance.
    // Each `__Ready` the host receives bumps the counter once.
    let pageReadyCount = 0
    const readyHandler: MessageHandler.Handler = () =>
      Effect.gen(function* () {
        pageReadyCount += 1
        const wasFirst = yield* Deferred.succeed(peerReady, undefined)
        yield* Effect.logInfo(
          `[effect-messaging] host received __Ready #${pageReadyCount} (gate ${
            wasFirst ? 'just opened' : 'already open'
          })`
        )
        if (onPageReady === undefined) return
        const send = yield* Deferred.await(sendMessageDeferred)
        yield* Effect.logDebug(
          `[effect-messaging] running onPageReady callbacks for __Ready #${pageReadyCount}`
        )
        yield* onPageReady(send)
      })

    // Only the host receives `__Ready`; injecting its handler as a control
    // entry keeps the registry ignorant of the handshake.
    const controlHandlers: ReadonlyArray<readonly [string, MessageHandler.Handler]> = isHost
      ? [[READY_TAG, readyHandler]]
      : []

    const registry = yield* makeHandlerRegistry<Bridges, InDir>({
      bridges,
      initialHandlers,
      controlHandlers,
    })
    const { enqueue } = yield* makeInboundDispatcher({
      bridges,
      inboundDirection,
      registry,
      adapter,
      // Inject the `__Ready` schema as a control message so the dispatcher
      // can decode it without knowing handshake semantics. Pairs with the
      // `controlHandlers` injection on the registry above.
      extraInboundSchemas: [ReadyMessageSchema],
    })
    const { sendMessage } = yield* makeOutboundPump({
      bridges,
      outboundDirection,
      adapter,
      ready: isHost ? Deferred.await(peerReady) : Effect.void,
    })
    yield* Deferred.succeed(sendMessageDeferred, sendMessage)

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
 *
 * @remarks
 * `onPageReady` (optional) fires inside the inbound dispatcher every
 * time the host receives `__Ready` — first page load and every
 * subsequent reload (Metro fast refresh, react-native-webview Android
 * blank-page workaround remount, `webviewRef.current?.reload()`, …).
 * Use it to push current state (auth token, route, etc.) that a freshly
 * loaded SPA needs but won't get a second time through the one-shot
 * `peerReady` Deferred. The closure captures `sendMessage` via an
 * internal Deferred so it doesn't matter that the dispatcher is built
 * before the outbound pump.
 */
const makeHostTransport = <const Bridges extends ReadonlyArray<Bridge.AnyBridge>>(config: {
  readonly bridges: Bridges
  readonly handlers: Bridge.HandlersByBridge<Bridges, 'WebToHost'>
  readonly onPageReady?: (send: MessageSender<Bridges, 'HostToWeb'>) => Effect.Effect<void>
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
    onPageReady: config.onPageReady,
  })

/**
 * Build the **web** endpoint of a bridge transport: it receives
 * `'HostToWeb'` messages (routed through `handlers`) and sends
 * `'WebToHost'` messages via `sendMessage`. The web's outbox flushes
 * immediately (its send gate is open from the start); it posts `__Ready`
 * to the host via `signalReady`.
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
  })

export { DuplicateTagError, makeHostTransport, makeWebTransport }
export type { BridgeTransport, MessageSender }
