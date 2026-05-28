import type { ParseResult, Scope } from 'effect'
import {
  Array,
  Data,
  Deferred,
  Effect,
  Match,
  pipe,
  Queue,
  Schema,
  Stream,
  Record,
  Option,
  HashMap,
} from 'effect'
import type * as Bridge from './bridge.ts'
import { senderByTag } from './internal/bridge-lookups.ts'
import { TransportAdapter } from './transport-adapter.ts'

/**
 * Two-bucket failure surface for inbound dispatch.
 *
 * - {@link ParseResult.ParseError}: anything Schema rejects — malformed
 *   JSON, an unrecognised `_tag`, or a known tag whose payload doesn't
 *   match. The dispatch core decodes via `Schema.parseJson(Schema.Union(...))`
 *   so the three previously-distinguished cases collapse into one
 *   parse-error variant.
 * - {@link DispatchInternalError}: an invariant the dup-check + lockstep
 *   schema/handler loop should make unreachable. Surfaces a wiring/refactor
 *   bug loudly instead of dropping the message silently — e.g., a deliberate
 *   `handlers: { Tag: undefined }` cast in a test fixture.
 */

/** Source channel an inbound message arrived through. */
type DispatchSource = 'live' | 'initial'

/**
 * Internal-invariant failure: the schema accepted the message but no
 * handler is wired for the tag. Reachable when a consumer passes
 * `undefined` as a handler (typically a test cast).
 */
class DispatchInternalError extends Data.TaggedError('Internal')<{
  readonly source: DispatchSource
  readonly tag: string
  readonly reason: string
}> {}

/** Union of every failure variant the inbound-dispatch fiber can yield. */
type DispatchError = ParseResult.ParseError | DispatchInternalError

/**
 * Map a structured {@link DispatchError} to a single
 * `Effect.logWarning` call. The dispatch fiber uses this in
 * `Effect.catchAll(dispatchErrorToLog)` so every dispatch failure
 * surfaces through the same channel.
 */
const dispatchErrorToLog = (error: DispatchError): Effect.Effect<void> => {
  if (error._tag === 'Internal') {
    return Effect.logWarning(
      `[effect-messaging] internal dispatch invariant violated for ${error.source} tag "${error.tag}": ${error.reason}`
    )
  }
  return Effect.logWarning(`[effect-messaging] failed to decode message: ${String(error)}`)
}

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
 * Scope close shuts down the queue, interrupts the dispatch fiber, and
 * detaches platform listeners.
 */
interface BridgeTransport<
  Bridges extends ReadonlyArray<Bridge.AnyBridge>,
  Side extends 'Host' | 'Web',
> {
  /**
   * Send any outbound message belonging to one of the wired bridges.
   *
   * @remarks
   * On the host side, the returned Effect suspends until the web has
   * posted `__Ready` (the handshake signal). On the web side, sends
   * flow immediately — the asymmetry matches the lifecycle: the host
   * is up before the web bundle even loads, so the web doesn't need
   * to wait on anyone.
   */
  readonly sendMessage: MessageSender<Bridges, Side>
  /**
   * Push one raw inbound string into the dispatch fiber. After scope
   * close the call is a no-op (the queue is shut down).
   */
  readonly enqueue: (raw: string) => Effect.Effect<void>
  /** Resolves once the dispatch fiber has drained every message enqueued before the call. */
  readonly flushed: Effect.Effect<void>
  /**
   * Tell the peer this side is ready to receive messages. Web posts
   * `__Ready` to the host (resolving the host's send-gating Deferred);
   * host is a no-op (the handshake is one-way). Idempotent.
   */
  readonly signalReady: Effect.Effect<void>
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

const make = <
  const Bridges extends ReadonlyArray<Bridge.AnyBridge>,
  const Side extends 'Host' | 'Web',
>(config: {
  readonly bridges: Bridges
  readonly layers: Bridge.TransportLayers<Bridges, Side>
  readonly side: Side
}): Effect.Effect<BridgeTransport<Bridges, Side>, never, TransportAdapter | Scope.Scope> =>
  Effect.gen(function* () {
    const { bridges, layers, side } = config
    const adapter = yield* TransportAdapter

    type AnyHandlers = Readonly<Record<string, Handler | undefined>>
    const handlersByBridgeIndex: ReadonlyArray<AnyHandlers | undefined> = yield* pipe(
      Array.zipWith(bridges, layers, (bridge, layer): Effect.Effect<AnyHandlers | undefined> => {
        if (bridge === undefined || layer === undefined) {
          return Effect.succeed<AnyHandlers | undefined>(undefined)
        }
        const half = bridge[side]
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const handlersEffect = Effect.provide(half.HandlerTag, layer) as Effect.Effect<
          AnyHandlers | undefined
        >
        return handlersEffect
      }),
      Effect.all
    )

    /**
     * Send-gating Deferred. Resolved when the local `__Ready` handler
     * runs. Host receives `__Ready` from the web peer; web self-queues
     * a `__Ready` below so the same dispatch path resolves the gate on
     * both sides (no parallel pre-resolve branch).
     */
    const peerReady = yield* Deferred.make<void>()

    const tagHandlerPairs = pipe(
      Array.zipWith(
        bridges,
        handlersByBridgeIndex,
        (bridge, handlers): [string, Handler | undefined][] => {
          if (bridge === undefined || handlers === undefined) {
            return [] as [string, Handler | undefined][]
          }
          return Record.toEntries(handlers)
        }
      ),
      Array.flatten,
      Array.filter((entry): entry is [string, Handler] => entry[1] !== undefined),
      Array.append([
        READY_TAG,
        () => Deferred.succeed(peerReady, undefined).pipe(Effect.asVoid),
      ] as [string, Handler])
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

    /**
     * Flat tag→handler map. Duplicate-tag detection runs above on
     * `tagHandlerPairs` so a wiring drift fails synchronously here,
     * before the dispatch fiber starts. The schema union below is
     * built from the same bridges so its tags stay in sync.
     */
    const handlerByTag = HashMap.fromIterable<string, Handler>(tagHandlerPairs)
    const innerSchemas: Array.NonEmptyArray<AnyTaggedSchema> = pipe(
      Array.flatMap(bridges, (bridge) => Record.values(bridge[side].InboundSchemas)),
      Array.map(Schema.typeSchema),
      Array.append(ReadyMessageSchema)
    )

    const taggedSenders = senderByTag(bridges, side)

    /**
     * Single-pass decode for inbound dispatch. `Schema.parseJson`
     * parses the wire string once; the surrounding `Schema.Union`
     * discriminates by `_tag` and produces the typed message in one
     * shot. Tags outside the union surface as `ParseError` (no
     * separate `UnknownTag` distinction — the union folds the two
     * cases into one).
     *
     * Today `innerSchemas` always carries at least `ReadyMessageSchema`
     * (appended above), so the empty-array branch below is defensive —
     * `Schema.Never` would reject every inbound message, matching "this
     * side accepts nothing inbound" if the `__Ready` append is ever
     * removed.
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
     * Decode one raw inbound message and route to its handler. Schema
     * acceptance implies the tag is in `handlerByTag` (built in lockstep
     * with `innerSchemas`); a missing handler entry surfaces as
     * `Internal` so a deliberate `handlers: { Tag: undefined }` cast
     * doesn't crash the dispatch fiber.
     */
    const decodeAndDispatch = (
      raw: string,
      source: DispatchSource
    ): Effect.Effect<void, DispatchError | ParseResult.ParseError, TransportAdapter> =>
      Effect.gen(function* () {
        // The Union schema decodes to `any`; re-narrow at this single
        // boundary. Schema acceptance guarantees `_tag: string`.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        const decoded = (yield* decodeMessage(raw)) as { readonly _tag: string }
        const maybeHandler = HashMap.get(handlerByTag, decoded._tag)

        return yield* Option.match(maybeHandler, {
          onNone: () =>
            Effect.fail(
              new DispatchInternalError({
                source,
                tag: decoded._tag,
                reason: 'handler is undefined for a dispatched tag',
              })
            ),
          onSome: (handler) => handler(decoded),
        })
      })

    interface QueueItem {
      readonly raw: string
      readonly source: DispatchSource
      readonly drainMarker?: Deferred.Deferred<void>
    }
    const queue = yield* Queue.unbounded<QueueItem>()

    const handleDrainMarker = (
      item: QueueItem & { readonly drainMarker: Deferred.Deferred<void> }
    ): Effect.Effect<void, never, TransportAdapter | Scope.Scope> =>
      Deferred.succeed(item.drainMarker, undefined).pipe(Effect.asVoid)

    const handleDecode = (
      item: QueueItem
    ): Effect.Effect<void, never, TransportAdapter | Scope.Scope> =>
      decodeAndDispatch(item.raw, item.source).pipe(
        Effect.catchAll(dispatchErrorToLog),
        // Handler defects don't take the dispatch fiber down.
        Effect.catchAllDefect((defect) =>
          Effect.logError(
            `[effect-messaging] handler defect; dispatch continues: ${String(defect)}`
          )
        )
      )

    yield* Effect.forkScoped(
      Stream.fromQueue(queue, { shutdown: true }).pipe(
        Stream.runForEach(
          Match.type<QueueItem>().pipe(
            Match.withReturnType<Effect.Effect<void, never, TransportAdapter | Scope.Scope>>(),
            Match.when({ drainMarker: Match.defined }, handleDrainMarker),
            Match.orElse((item) => handleDecode(item))
          )
        )
      )
    )

    if (side === 'Web') {
      yield* Queue.offer(queue, { raw: '{"_tag":"__Ready"}', source: 'initial' })
    }
    const initial = yield* adapter.drainInitial
    for (const raw of initial) {
      yield* Queue.offer(queue, { raw, source: 'initial' })
    }

    // After scope close the queue is shut down; `Effect.ignore` drops the resulting interrupt cleanly.
    const enqueue = (raw: string): Effect.Effect<void> =>
      Queue.offer(queue, { raw, source: 'live' }).pipe(Effect.ignore)

    if (adapter.attachBareSender !== undefined) {
      yield* adapter.attachBareSender(enqueue)
    }

    /** Sentinel-marker drain: the dispatch fiber processes the marker after every prior message. */
    const flushed: Effect.Effect<void> = pipe(
      Deferred.make<void>(),
      Effect.tap((marker) => Queue.offer(queue, { raw: '', source: 'live', drainMarker: marker })),
      Effect.flatMap((marker) => Deferred.await(marker))
    )

    const sendMessage: MessageSender<Bridges, Side> = (
      message: Bridge.SendableMessage<Bridges, Side>
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Deferred.await(peerReady)
        const sender = taggedSenders.get(message._tag)
        if (sender === undefined) {
          yield* Effect.logWarning(
            `[effect-messaging] sendMessage: no bridge owns tag "${message._tag}"; dropping`
          )
          return undefined
        }
        yield* sender(message)
        return undefined
      }).pipe(Effect.provideService(TransportAdapter, adapter))

    const signalReady = {
      Web: adapter.bareSender(READY_RAW),
      Host: Effect.void,
    }[side]

    return {
      sendMessage,
      enqueue,
      flushed,
      signalReady,
    }
  })

export { make, READY_TAG }
export type { BridgeTransport, MessageSender }
