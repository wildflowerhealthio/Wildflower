import type { ParseResult, Scope } from 'effect'
import {
  Array,
  Deferred,
  Effect,
  HashMap,
  Match,
  Option,
  pipe,
  Queue,
  Record,
  Ref,
  Schema,
  Stream,
} from 'effect'
import type * as Bridge from './bridge.ts'
import { assertNoDuplicateTags } from './internal/assert-no-duplicate-tags.ts'
import { offerQuietly } from './internal/offer-quietly.ts'
import type * as MessageHandler from './message-handler.ts'
import * as Message from './message.ts'
import { TransportAdapter } from './transport-adapter.ts'

/** The web-→-host handshake signal. Resolves the host's `peerReady` Deferred. */
const READY_TAG = '__Ready' as const

/**
 * Inner (post-`parseJson`) schema for the `__Ready` control message.
 * Composed into the host-side dispatch union and used to encode the
 * outbound wire string on the web side via {@link READY_RAW}.
 */
const ReadyMessageSchema = Schema.TaggedStruct(READY_TAG, {})

/** Wire-format schema for `__Ready`: encoded as a JSON tagged struct. */
const ReadyMessageWireSchema = Schema.parseJson(ReadyMessageSchema)

/**
 * Pre-encoded `__Ready` wire string. Schema-encoded so the wire form
 * stays in lockstep with the inbound dispatch's union member.
 */
const READY_RAW = Schema.encodeSync(ReadyMessageWireSchema)({ _tag: READY_TAG })

/**
 * Typed outbound sender for every wired bridge — one function accepting
 * the union of decoded messages sendable in `OutDir`. The transport's
 * public `sendMessage` strips the {@link TransportAdapter} requirement.
 *
 * @remarks
 * `Bridges` appears only inside `SendableMessage`, a function-parameter
 * (contravariant) position, so no variance annotation is needed — TS
 * measures the contravariance and lets `callTransportReady` hand a
 * full-tuple sender to each narrow per-slot callback structurally.
 */
type MessageSender<
  Bridges extends ReadonlyArray<Bridge.AnyBridge>,
  OutDir extends Bridge.Direction,
> = (message: Bridge.SendableMessage<Bridges, OutDir>) => Effect.Effect<void>

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
   * Replace the active per-bridge handler records with a single
   * {@link Ref} set, applied atomically against the dispatch fiber's
   * reads.
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

/**
 * Loose schema bound for members of the dispatch union. Each member is
 * a typeSchema'd `parseJson(TaggedStruct(...))` (i.e., `Schema<A, A>`
 * for some `A extends { _tag: string }`); the heterogeneous decoded
 * types collapse via `any` here, then re-narrow at the routing site
 * where we read `_tag` for the handler lookup.
 */
// oxlint-disable-next-line typescript/no-explicit-any
type AnyTaggedSchema = Schema.Schema<any, any, never>

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
     * Send-gating Deferred. Resolved when the local `__Ready` handler
     * runs. Host receives `__Ready` from the web peer; web self-queues
     * a `__Ready` below so the same dispatch path resolves the gate on
     * both sides (no parallel pre-resolve branch).
     */
    const peerReady = yield* Deferred.make<void>()
    const readyTagHandler: MessageHandler.Handler = () =>
      Deferred.succeed(peerReady, undefined).pipe(Effect.asVoid)

    /**
     * Pure tag→handler map builder. Folds the `Bridges` × handler-records
     * parallel tuples into the flat `HashMap<tag, Handler>` the dispatch
     * fiber reads through {@link handlersRef}. Always appends the
     * `__Ready` handler so the handshake survives every replace.
     *
     * Throws synchronously on duplicate inbound tags across bridges — a
     * wiring error. At initial `make` this fails the build loudly; from
     * {@link registerHandlers} the throw surfaces as a defect and the
     * prior map stays in place (the `Ref.set` never runs).
     */
    const buildHandlerByTag = (
      handlersByBridge: Bridge.HandlersByBridge<Bridges, InDir>
    ): HashMap.HashMap<string, MessageHandler.Handler> => {
      const tagHandlerPairs = pipe(
        Array.zipWith(
          bridges,
          handlersByBridge,
          (bridge, handlers): [string, MessageHandler.Handler | undefined][] => {
            if (bridge === undefined || handlers === undefined) {
              return []
            }
            // Each record's handlers accept their specific message type;
            // erase to the routing-site `Handler` shape (re-narrowed by
            // `_tag` at dispatch).
            return Record.toEntries(handlers as MessageHandler.AnyHandlers)
          }
        ),
        Array.flatten,
        Array.filter((entry): entry is [string, MessageHandler.Handler] => entry[1] !== undefined),
        Array.append([READY_TAG, readyTagHandler] as [string, MessageHandler.Handler])
      )
      assertNoDuplicateTags(
        Array.map(tagHandlerPairs, ([tag]) => tag),
        'inbound'
      )

      return HashMap.fromIterable<string, MessageHandler.Handler>(tagHandlerPairs)
    }

    /**
     * Flat tag→handler map, read by the dispatch fiber on every inbound
     * message. Held in a {@link Ref} so {@link registerHandlers} can swap
     * it without rebuilding the queues, dispatch fiber, or `peerReady`
     * Deferred. The schema union below stays static — it's bridges-derived
     * and the bridges tuple is fixed for the transport's lifetime.
     */
    const handlersRef = yield* Ref.make(buildHandlerByTag(initialHandlers))

    const innerSchemas: Array.NonEmptyArray<AnyTaggedSchema> = pipe(
      Array.flatMap(bridges, (bridge) => Record.values(bridge[inboundDirection])),
      Array.map(Schema.typeSchema),
      Array.append(ReadyMessageSchema)
    )

    /**
     * Merged outbound schema record across every wired bridge for this
     * side — `{[tag]: schema}` the pump encodes against via
     * {@link Message.stringifyMessage}. Throws on an outbound-tag
     * collision, the same wiring-error policy the inbound dup check
     * enforces.
     */
    assertNoDuplicateTags(
      Array.flatMap(bridges, (bridge) => Record.keys(bridge[outboundDirection])),
      'outbound'
    )
    const outboundByTag: Record<string, Message.AnyStringEncodedSchema> = {}
    for (const bridge of bridges) {
      for (const [tag, schema] of Record.toEntries(bridge[outboundDirection])) {
        outboundByTag[tag] = schema
      }
    }

    /**
     * Single-pass decode for inbound dispatch. `Schema.parseJson` parses
     * the wire string once; the surrounding `Schema.Union` discriminates
     * by `_tag` and produces the typed message in one shot. Tags outside
     * the union surface as `ParseError` and are logged-and-dropped; a
     * known tag with no handler is logged-and-dropped too — see {@link dispatch}.
     *
     * Today `innerSchemas` always carries at least `ReadyMessageSchema`
     * (appended above), so the single-member branch is the floor; the
     * `Schema.Union` branch covers every real transport.
     */
    const dispatchMessage: AnyTaggedSchema = Match.value(innerSchemas).pipe(
      Match.withReturnType<AnyTaggedSchema>(),
      Match.when(
        (arr): arr is [AnyTaggedSchema] => arr.length == 1,
        ([first]) => first
      ),
      Match.orElse(([first, ...rest]) => Schema.Union(first, ...rest))
    )

    const decodeMessage = Schema.decode(Schema.parseJson(dispatchMessage))

    /**
     * Decode one raw inbound message and route to its handler, or
     * log-and-drop it when no handler is registered for its tag. Schema
     * acceptance guarantees `_tag: string`; re-narrow at this single
     * boundary.
     */
    const dispatch = (raw: string): Effect.Effect<void, ParseResult.ParseError> =>
      Effect.gen(function* () {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        const decoded = (yield* decodeMessage(raw)) as MessageHandler.DecodedMessage
        const handlerByTag = yield* Ref.get(handlersRef)
        yield* Option.match(HashMap.get(handlerByTag, decoded._tag), {
          onSome: (handler) => handler(decoded),
          onNone: () =>
            Effect.logWarning(
              `[effect-messaging] no handler for inbound tag "${decoded._tag}"; dropping`
            ),
        })
      })

    const inbox = yield* Queue.unbounded<string>()

    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromQueue(inbox, { shutdown: true }), (raw) =>
        dispatch(raw).pipe(
          Effect.catchAll((error) =>
            Effect.logWarning(`[effect-messaging] failed to decode message: ${String(error)}`)
          ),
          // Handler defects don't take the dispatch fiber down.
          Effect.catchAllDefect((defect) =>
            Effect.logError(`[effect-messaging] dispatch defect; continues: ${String(defect)}`)
          )
        )
      )
    )

    if (!isHost) {
      yield* Queue.offer(inbox, READY_RAW)
    }
    const initial = yield* adapter.drainInitial
    for (const raw of initial) {
      yield* Queue.offer(inbox, raw)
    }

    const enqueue = (raw: string): Effect.Effect<void> => offerQuietly(inbox, raw)

    if (adapter.attachBareSender !== undefined) {
      yield* adapter.attachBareSender(enqueue)
    }

    /**
     * Outbox: sends are offered here immediately. A single pump fiber
     * gates once on `peerReady`, then drains forever — so messages
     * enqueued before the peer is ready ride out in order the moment the
     * handshake lands.
     */
    const outbox = yield* Queue.unbounded<Bridge.SendableMessage<Bridges, OutDir>>()

    const sendMessage: MessageSender<Bridges, OutDir> = (
      message: Bridge.SendableMessage<Bridges, OutDir>
    ): Effect.Effect<void> => offerQuietly(outbox, message)

    yield* Effect.forkScoped(
      Deferred.await(peerReady).pipe(
        Effect.andThen(
          Stream.runForEach(Stream.fromQueue(outbox, { shutdown: true }), (message) => {
            if (outboundByTag[message._tag] === undefined) {
              return Effect.logWarning(
                `[effect-messaging] sendMessage: no bridge owns tag "${message._tag}"; dropping`
              )
            }
            return adapter.bareSender(Message.stringifyMessage(outboundByTag, message))
          })
        )
      )
    )

    // One-way handshake: the web posts `__Ready` to the host; the host
    // never sends one (it waits to receive the web's).
    const signalReady = isHost ? Effect.void : adapter.bareSender(READY_RAW)

    // `Effect.suspend` defers `buildHandlerByTag` to run time: a duplicate-tag
    // throw surfaces as a defect on the returned Effect (not at call
    // construction), and the `Ref.set` never runs, so the prior map stays put.
    const registerHandlers = (
      handlers: Bridge.HandlersByBridge<Bridges, InDir>
    ): Effect.Effect<void> =>
      Effect.suspend(() => Ref.set(handlersRef, buildHandlerByTag(handlers)))

    return {
      sendMessage,
      enqueue,
      signalReady,
      registerHandlers,
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
