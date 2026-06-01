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
import { senderByTag } from './internal/bridge-lookups.ts'
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
 * Function-intersection of every wired bridge's typed sender for the
 * specified side. The transport's public `sendMessage` strips the
 * {@link TransportAdapter} requirement.
 */
type MessageSender<
  out Bridges extends ReadonlyArray<Bridge.AnyBridge>,
  Side extends 'Host' | 'Web',
> = (message: Bridge.SendableMessage<Bridges, Side>) => Effect.Effect<void>

/**
 * Cross-platform bridge transport composing one or more
 * {@link Bridge.Bridge} declarations into a single Effect program.
 *
 * @remarks
 * Two queues run behind the public surface: an **outbox** (sends are
 * offered immediately and a pump fiber drains them once the peer signals
 * `__Ready`) and an **inbox** (raw inbound strings plus `registerHandlers`
 * control items, processed in FIFO order by a single dispatch fiber).
 * Scope close shuts down both queues, interrupts both fibers, and
 * detaches platform listeners.
 */
interface BridgeTransport<
  Bridges extends ReadonlyArray<Bridge.AnyBridge>,
  Side extends 'Host' | 'Web',
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
  readonly sendMessage: MessageSender<Bridges, Side>
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
   * Replace the active per-bridge handler records. Routed through the
   * inbox queue as a control item, so it is ordered against in-flight
   * inbound messages: a message that arrived before its handler was
   * registered is parked per-tag and replayed in arrival order once a
   * covering handler lands. The returned Effect resolves after the swap
   * (and any parked-message replay) has been applied.
   *
   * @remarks
   * Pure — handlers are plain records, so there is no layer/resource
   * discharge and repeated calls don't accumulate. Replace semantics:
   * the supplied records become the whole active set; a tag absent from
   * the new records loses its handler (future messages for it park).
   */
  readonly registerHandlers: (
    handlers: Bridge.HandlersByBridge<Bridges, Side>
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

/**
 * Handler invoked by the dispatch fiber when a tag's message arrives.
 *
 * @remarks
 * The `TransportAdapter` requirement matches `HandlersFor` (handlers can
 * reply via the same-bridge `send(...)`). The dispatch fiber discharges
 * the requirement per-invocation under the transport's own adapter, so
 * handlers returning `Effect<void, never, never>` and handlers calling
 * `send(...)` both compose into the same dispatch path.
 */
type Handler = (message: { readonly _tag: string }) => Effect.Effect<void, never, TransportAdapter>

type AnyHandlers = Readonly<Record<string, Handler | undefined>>

/** Decoded inbound message — re-narrowed to its `_tag` at the routing site. */
type DecodedMessage = { readonly _tag: string }

/**
 * Items flowing through the inbox. `message` carries a raw inbound wire
 * string; `register` swaps the active handler records (and resolves
 * `done` once applied). One consumer fiber processes both in FIFO order,
 * so a `register` is correctly sequenced against the messages around it.
 */
type InboxItem<Bridges extends ReadonlyArray<Bridge.AnyBridge>, Side extends 'Host' | 'Web'> =
  | { readonly kind: 'message'; readonly raw: string }
  | {
      readonly kind: 'register'
      readonly handlers: Bridge.HandlersByBridge<Bridges, Side>
      readonly done: Deferred.Deferred<void>
    }

const make = <
  const Bridges extends ReadonlyArray<Bridge.AnyBridge>,
  const Side extends 'Host' | 'Web',
>(config: {
  readonly bridges: Bridges
  readonly handlers: Bridge.HandlersByBridge<Bridges, Side>
  readonly side: Side
}): Effect.Effect<BridgeTransport<Bridges, Side>, never, TransportAdapter | Scope.Scope> =>
  Effect.gen(function* () {
    const { bridges, handlers: initialHandlers, side } = config
    const adapter = yield* TransportAdapter

    /**
     * Send-gating Deferred. Resolved when the local `__Ready` handler
     * runs. Host receives `__Ready` from the web peer; web self-queues
     * a `__Ready` below so the same dispatch path resolves the gate on
     * both sides (no parallel pre-resolve branch).
     */
    const peerReady = yield* Deferred.make<void>()
    const readyTagHandler: Handler = () =>
      Deferred.succeed(peerReady, undefined).pipe(Effect.asVoid)

    /**
     * Pure tag→handler map builder. Folds the `Bridges` × handler-records
     * parallel tuples into the flat `HashMap<tag, Handler>` the dispatch
     * fiber reads through {@link handlersRef}. Always appends the
     * `__Ready` handler so the handshake survives every replace.
     *
     * Throws synchronously on duplicate inbound tags across bridges — a
     * wiring error. At initial `make` this fails the build loudly; on a
     * `register` the dispatch fiber catches the defect, logs it, and
     * keeps the prior map in place (see the consumer's `catchAllDefect`).
     */
    const buildHandlerByTag = (
      handlersByBridge: Bridge.HandlersByBridge<Bridges, Side>
    ): HashMap.HashMap<string, Handler> => {
      const tagHandlerPairs = pipe(
        Array.zipWith(
          bridges,
          handlersByBridge,
          (bridge, handlers): [string, Handler | undefined][] => {
            if (bridge === undefined || handlers === undefined) {
              return []
            }
            // Each record's handlers accept their specific message type;
            // erase to the routing-site `Handler` shape (re-narrowed by
            // `_tag` at dispatch).
            return Record.toEntries(handlers as AnyHandlers)
          }
        ),
        Array.flatten,
        Array.filter((entry): entry is [string, Handler] => entry[1] !== undefined),
        Array.append([READY_TAG, readyTagHandler] as [string, Handler])
      )
      const [repeatedTags] = Array.reduce(
        tagHandlerPairs,
        [new Set<string>(), new Set<string>()] as const,
        ([repeats, seen], [tag]) => {
          if (seen.has(tag)) {
            repeats.add(tag)
          } else {
            seen.add(tag)
          }

          return [repeats, seen]
        }
      )
      if (repeatedTags.size > 0) {
        throw new Error(`duplicate inbound tag(s) "${[...repeatedTags].join('", "')}"`)
      }

      return HashMap.fromIterable<string, Handler>(tagHandlerPairs)
    }

    /**
     * Flat tag→handler map, read by the dispatch fiber on every inbound
     * message. Held in a {@link Ref} so {@link registerHandlers} can swap
     * it without rebuilding the queues, dispatch fiber, or `peerReady`
     * Deferred. The schema union below stays static — it's bridges-derived
     * and the bridges tuple is fixed for the transport's lifetime.
     */
    const handlersRef = yield* Ref.make(buildHandlerByTag(initialHandlers))

    /**
     * Per-tag parking lot for inbound messages whose tag has no handler
     * yet. Schema acceptance proves the tag is a known inbound message,
     * so it's held (not dropped) until a {@link registerHandlers} call
     * installs a covering handler, then replayed in arrival order.
     */
    const parkedRef = yield* Ref.make(HashMap.empty<string, ReadonlyArray<DecodedMessage>>())

    const innerSchemas: Array.NonEmptyArray<AnyTaggedSchema> = pipe(
      Array.flatMap(bridges, (bridge) => Record.values(bridge[side].InboundSchemas)),
      Array.map(Schema.typeSchema),
      Array.append(ReadyMessageSchema)
    )

    const taggedSenders = senderByTag(bridges, side)

    /**
     * Single-pass decode for inbound dispatch. `Schema.parseJson` parses
     * the wire string once; the surrounding `Schema.Union` discriminates
     * by `_tag` and produces the typed message in one shot. Tags outside
     * the union surface as `ParseError` and are logged-and-dropped (a
     * known tag with no handler is parked instead — see {@link dispatchOrPark}).
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
     * Decode one raw inbound message and route to its handler, or park
     * it under its tag when no handler is registered yet. Schema
     * acceptance guarantees `_tag: string`; re-narrow at this single
     * boundary.
     */
    const dispatchOrPark = (
      raw: string
    ): Effect.Effect<void, ParseResult.ParseError, TransportAdapter> =>
      Effect.gen(function* () {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        const decoded = (yield* decodeMessage(raw)) as DecodedMessage
        const handlerByTag = yield* Ref.get(handlersRef)
        yield* Option.match(HashMap.get(handlerByTag, decoded._tag), {
          onSome: (handler) => handler(decoded),
          onNone: () =>
            Ref.update(parkedRef, (parked) =>
              HashMap.set(parked, decoded._tag, [
                ...Option.getOrElse(
                  HashMap.get(parked, decoded._tag),
                  (): ReadonlyArray<DecodedMessage> => []
                ),
                decoded,
              ])
            ),
        })
      })

    /**
     * Apply a `register` control item: rebuild the handler map (may throw
     * on a duplicate-tag wiring error — surfaces as a defect the consumer
     * catches), swap the Ref, then replay every parked message whose tag
     * the new map now covers, clearing each replayed tag.
     */
    const applyRegister = (
      next: Bridge.HandlersByBridge<Bridges, Side>
    ): Effect.Effect<void, never, TransportAdapter> =>
      Effect.gen(function* () {
        const nextMap = buildHandlerByTag(next)
        yield* Ref.set(handlersRef, nextMap)
        const parked = yield* Ref.get(parkedRef)
        yield* Effect.forEach(
          HashMap.toEntries(parked),
          ([tag, messages]) =>
            Option.match(HashMap.get(nextMap, tag), {
              onNone: () => Effect.void,
              onSome: (handler) =>
                Effect.forEach(messages, (message) => handler(message), { discard: true }).pipe(
                  Effect.andThen(Ref.update(parkedRef, (current) => HashMap.remove(current, tag)))
                ),
            }),
          { discard: true }
        )
      })

    const inbox = yield* Queue.unbounded<InboxItem<Bridges, Side>>()

    const processItem = (
      item: InboxItem<Bridges, Side>
    ): Effect.Effect<void, ParseResult.ParseError, TransportAdapter> =>
      item.kind === 'register'
        ? applyRegister(item.handlers).pipe(Effect.ensuring(Deferred.succeed(item.done, undefined)))
        : dispatchOrPark(item.raw)

    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromQueue(inbox, { shutdown: true }), (item) =>
        processItem(item).pipe(
          Effect.catchAll((error) =>
            Effect.logWarning(`[effect-messaging] failed to decode message: ${String(error)}`)
          ),
          // Handler defects (and register wiring throws) don't take the
          // dispatch fiber down.
          Effect.catchAllDefect((defect) =>
            Effect.logError(`[effect-messaging] dispatch defect; continues: ${String(defect)}`)
          )
        )
      ).pipe(Effect.provideService(TransportAdapter, adapter))
    )

    if (side === 'Web') {
      yield* Queue.offer(inbox, { kind: 'message', raw: '{"_tag":"__Ready"}' })
    }
    const initial = yield* adapter.drainInitial
    for (const raw of initial) {
      yield* Queue.offer(inbox, { kind: 'message', raw })
    }

    // After scope close the queue is shut down; offering then fails with an
    // interrupt cause, which `Effect.ignore` (typed-error channel only) lets
    // through. `catchAllCause` swallows it so a late enqueue is a clean no-op.
    const enqueue = (raw: string): Effect.Effect<void> =>
      Queue.offer(inbox, { kind: 'message', raw }).pipe(Effect.catchAllCause(() => Effect.void))

    if (adapter.attachBareSender !== undefined) {
      yield* adapter.attachBareSender(enqueue)
    }

    /**
     * Outbox: sends are offered here immediately. A single pump fiber
     * gates once on `peerReady`, then drains forever — so messages
     * enqueued before the peer is ready ride out in order the moment the
     * handshake lands.
     */
    const outbox = yield* Queue.unbounded<Bridge.SendableMessage<Bridges, Side>>()

    const sendMessage: MessageSender<Bridges, Side> = (
      message: Bridge.SendableMessage<Bridges, Side>
    ): Effect.Effect<void> => Queue.offer(outbox, message).pipe(Effect.ignore)

    yield* Effect.forkScoped(
      Deferred.await(peerReady)
        .pipe(
          Effect.andThen(
            Stream.runForEach(Stream.fromQueue(outbox, { shutdown: true }), (message) => {
              const sender = taggedSenders.get(message._tag)
              if (sender === undefined) {
                return Effect.logWarning(
                  `[effect-messaging] sendMessage: no bridge owns tag "${message._tag}"; dropping`
                )
              }
              return sender(message)
            })
          )
        )
        .pipe(Effect.provideService(TransportAdapter, adapter))
    )

    const signalReady = {
      Web: adapter.bareSender(READY_RAW),
      Host: Effect.void,
    }[side]

    const registerHandlers = (
      handlers: Bridge.HandlersByBridge<Bridges, Side>
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<void>()
        const accepted = yield* Queue.offer(inbox, { kind: 'register', handlers, done })
        // A shut-down inbox (post scope close) rejects the offer; skip
        // the await so a late call can't hang on a `done` that never resolves.
        if (accepted) {
          yield* Deferred.await(done)
        }
      })

    return {
      sendMessage,
      enqueue,
      signalReady,
      registerHandlers,
    }
  })

export { make }
export type { BridgeTransport, MessageSender }
