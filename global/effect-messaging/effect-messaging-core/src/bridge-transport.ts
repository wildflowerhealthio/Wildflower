import type { Scope } from 'effect'
import { Deferred, Effect } from 'effect'
import type * as Bridge from './bridge.ts'
import { DuplicateTagError } from './internal/assert-no-duplicate-tags.ts'
import { makeHandlerRegistry } from './internal/handler-registry.ts'
import { READY_TAG, ReadyMessageSchema } from './internal/handshake-message.ts'
import { makeInboundDispatcher } from './internal/inbound-dispatcher.ts'
import { makeOutboundPump, type MessageSender } from './internal/outbound-pump.ts'
import type * as MessageHandler from './message-handler.ts'
import { TransportAdapter } from './transport-adapter.ts'

/**
 * Host endpoint of a bridge transport, composing one or more
 * {@link Bridge.Bridge} declarations into a single Effect program. It
 * receives `'WebToHost'` messages (routed through the registered
 * handlers) and sends `'HostToWeb'` messages via `sendMessage`.
 *
 * @remarks
 * Two queues run behind the public surface: an **outbox** (sends are
 * offered immediately and a pump fiber drains them once the web peer
 * signals `__Ready`) and an **inbox** (raw inbound strings processed in
 * FIFO order by a single dispatch fiber). Scope close shuts down both
 * queues, interrupts both fibers, and detaches platform listeners.
 */
interface BridgeTransport<Bridges extends ReadonlyArray<Bridge.AnyBridge>> {
  /**
   * Enqueue an outbound message belonging to one of the wired bridges.
   *
   * @remarks
   * The send is buffered in the outbox and never suspends the caller.
   * A pump fiber flushes the outbox once the web's `__Ready` arrives —
   * the host is up before the web bundle loads, so it holds its sends
   * until the page can receive them.
   */
  readonly sendMessage: MessageSender<Bridges, 'HostToWeb'>
  /**
   * Push one raw inbound string into the dispatch fiber. After scope
   * close the call is a no-op (the queue is shut down).
   */
  readonly enqueue: (raw: string) => Effect.Effect<void>
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
    handlers: Bridge.HandlersByBridge<Bridges, 'WebToHost'>
  ) => Effect.Effect<void, DuplicateTagError>
}

/**
 * Build the **host** endpoint of a bridge transport: it receives
 * `'WebToHost'` messages (routed through `handlers`) and sends
 * `'HostToWeb'` messages via `sendMessage`. The host waits for the web
 * peer's `__Ready` before flushing its outbox.
 *
 * @remarks
 * `onPageReady` (optional) fires inside the inbound dispatcher every
 * time the host receives `__Ready` — first page load and every
 * subsequent reload (a fast refresh, a WebView remount, an explicit
 * reload, …). Use it to push current state (auth token, route, etc.)
 * that a freshly loaded SPA needs but won't get a second time through
 * the one-shot `peerReadyGate` Deferred. The closure captures
 * `sendMessage` via an internal Deferred so it doesn't matter that the
 * dispatcher is built before the outbound pump.
 */
const makeHostTransport = <const Bridges extends ReadonlyArray<Bridge.AnyBridge>>(config: {
  readonly bridges: Bridges
  readonly handlers: Bridge.HandlersByBridge<Bridges, 'WebToHost'>
  readonly onPageReady?: (send: MessageSender<Bridges, 'HostToWeb'>) => Effect.Effect<void>
}): Effect.Effect<BridgeTransport<Bridges>, never, TransportAdapter | Scope.Scope> =>
  Effect.gen(function* () {
    const { bridges, handlers: initialHandlers, onPageReady } = config
    const adapter = yield* TransportAdapter

    // One-shot send gate: the outbox stays buffered until this resolves
    // on receiving the web's `__Ready`. The reload re-fire path runs
    // through `onPageReady` (invoked for every `__Ready`), not this gate.
    const peerReadyGate = yield* Deferred.make<void>()
    // Forward reference to `sendMessage`: the inbound dispatcher is
    // built before the outbound pump, so the `__Ready` handler awaits
    // the sender rather than capturing it by value. Resolved once, just
    // after `makeOutboundPump` returns. A Deferred (vs a `{ current }`
    // ref) lets the handler suspend cleanly until the pump is up.
    const pendingSender = yield* Deferred.make<MessageSender<Bridges, 'HostToWeb'>>()
    let readyHandshakeCount = 0
    const handleReadyMessage: MessageHandler.Handler = () =>
      Effect.gen(function* () {
        readyHandshakeCount += 1
        const gateJustOpened = yield* Deferred.succeed(peerReadyGate, undefined)
        yield* Effect.logDebug(
          `[effect-messaging] host received __Ready #${readyHandshakeCount} (gate ${
            gateJustOpened ? 'just opened' : 'already open'
          })`
        )
        if (onPageReady === undefined) return
        const send = yield* Deferred.await(pendingSender)
        yield* Effect.logDebug(
          `[effect-messaging] running onPageReady callbacks for __Ready #${readyHandshakeCount}`
        )
        yield* onPageReady(send)
      })

    // Injecting the `__Ready` handler as a control entry keeps the
    // registry ignorant of the handshake.
    const registry = yield* makeHandlerRegistry<Bridges, 'WebToHost'>({
      bridges,
      initialHandlers,
      controlHandlers: [[READY_TAG, handleReadyMessage]],
    })
    const { enqueue } = yield* makeInboundDispatcher({
      bridges,
      inboundDirection: 'WebToHost',
      registry,
      adapter,
      // Inject the `__Ready` schema as a control message so the dispatcher
      // can decode it without knowing handshake semantics. Pairs with the
      // `controlHandlers` injection on the registry above.
      extraInboundSchemas: [ReadyMessageSchema],
    })
    const { sendMessage } = yield* makeOutboundPump({
      bridges,
      outboundDirection: 'HostToWeb',
      adapter,
      ready: Deferred.await(peerReadyGate),
    })
    yield* Deferred.succeed(pendingSender, sendMessage)

    return {
      sendMessage,
      enqueue,
      registerHandlers: registry.register,
    }
  })

export { DuplicateTagError, makeHostTransport }
export type { BridgeTransport, MessageSender }
