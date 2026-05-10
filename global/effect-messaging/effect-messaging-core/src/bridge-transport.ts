import type { Scope } from 'effect'
import { Deferred, Effect, Queue, Runtime, Schema, Stream } from 'effect'
import * as Bridge from './bridge.ts'
import * as DispatchError from './dispatch-error.ts'
import { TransportAdapter } from './transport-adapter.ts'

/** The web-→-host handshake signal. Resolves the host's `peerReady` Deferred. */
const READY_TAG = '__Ready' as const

/**
 * Inner (post-`parseJson`) schema for the `__Ready` control message.
 * Composed into the host-side dispatch union and used to encode the
 * outbound wire string on the web side via {@link READY_RAW}.
 */
const ReadyMessage = Schema.TaggedStruct(READY_TAG, {})

/** Wire-format schema for `__Ready`: encoded as a JSON tagged struct. */
const ReadyMessageWire = Schema.parseJson(ReadyMessage)

/**
 * Pre-encoded `__Ready` wire string. Schema-encoded so the wire form
 * stays in lockstep with the inbound dispatch's union member.
 */
const READY_RAW = Schema.encodeSync(ReadyMessageWire)({ _tag: READY_TAG })

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
  readonly sendMessage: Bridge.SenderIntersection<Bridges, Side>
  /**
   * Push one raw inbound string into the dispatch fiber. After scope
   * close the call is a no-op (the queue is shut down).
   */
  readonly enqueue: (raw: string) => void
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

/** Handler invoked by the dispatch fiber when a tag's message arrives. */
type Handler = (message: { readonly _tag: string }) => Effect.Effect<void>

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

    /**
     * Send-gating Deferred. The host suspends `sendMessage` on this
     * until the web posts `__Ready`. On the web side we resolve it
     * immediately so the same `Deferred.await` is a no-op.
     */
    const peerReady = yield* Deferred.make<void>()
    if (side === 'Web') {
      yield* Deferred.succeed(peerReady, undefined)
    }

    type AnyHandlers = Readonly<Record<string, Handler | undefined>>
    const handlersByBridgeIndex: Array<AnyHandlers | undefined> = []
    for (let i = 0; i < bridges.length; i++) {
      const bridge = bridges[i]
      const layer = layers[i]
      if (bridge === undefined || layer === undefined) {
        handlersByBridgeIndex.push(undefined)
        continue
      }
      const half = bridge[side]
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      const handlers = (yield* Effect.provide(half.HandlerTag, layer)) as AnyHandlers
      handlersByBridgeIndex.push(handlers)
    }

    /**
     * Flat tag→handler map plus per-tag inner schemas built in lockstep.
     * Duplicate-tag detection runs over the same loop so a wiring drift
     * fails synchronously here, before the dispatch fiber starts.
     */
    const handlerByTag = new Map<string, Handler | undefined>()
    const innerSchemas: AnyTaggedSchema[] = []
    for (let i = 0; i < bridges.length; i++) {
      const bridge = bridges[i]
      const handlers = handlersByBridgeIndex[i]
      if (bridge === undefined || handlers === undefined) continue
      const half = bridge[side]
      for (const [tag, schema] of Object.entries(half.InboundSchemas)) {
        if (handlerByTag.has(tag)) {
          const existingBridge =
            bridges.find((b, j) => j < i && Object.hasOwn(b[side].InboundSchemas, tag))?.name ?? '?'
          throw new Error(
            `[effect-messaging] duplicate inbound tag "${tag}" across bridges "${existingBridge}" and "${bridge.name}"`
          )
        }
        handlerByTag.set(tag, handlers[tag])
        innerSchemas.push(Schema.typeSchema(schema))
      }
    }

    /**
     * Control-channel hookup. The host receives `__Ready` from web and
     * resolves the send gate; web doesn't expect any control messages
     * from the host today, so its dispatch union is bridge-only.
     */
    if (side === 'Host') {
      handlerByTag.set(READY_TAG, () => Deferred.succeed(peerReady, undefined).pipe(Effect.asVoid))
      innerSchemas.push(ReadyMessage)
    }

    const taggedSenders = Bridge.senderByTag(bridges, side)

    /**
     * Single-pass decode for inbound dispatch. `Schema.parseJson`
     * parses the wire string once; the surrounding `Schema.Union`
     * discriminates by `_tag` and produces the typed message in one
     * shot. Tags outside the union surface as `ParseError` (no
     * separate `UnknownTag` distinction — the union folds the two
     * cases into one).
     */
    // A side with zero inbound (e.g., bridges that only send) gets
    // `Schema.Never`, which rejects every message — equivalent to "this
    // side accepts nothing inbound." Anything that arrives is logged as a
    // parse error.
    const firstSchema = innerSchemas[0]
    const dispatchMessage: AnyTaggedSchema =
      firstSchema === undefined
        ? Schema.Never
        : innerSchemas.length === 1
          ? firstSchema
          : Schema.Union(firstSchema, ...innerSchemas.slice(1))
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
      source: DispatchError.Source
    ): Effect.Effect<void, DispatchError.DispatchError> =>
      Effect.gen(function* () {
        // The Union schema decodes to `any`; re-narrow at this single
        // boundary. Schema acceptance guarantees `_tag: string`.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        const decoded = (yield* decodeMessage(raw)) as { readonly _tag: string }
        const handler = handlerByTag.get(decoded._tag)
        if (handler === undefined) {
          return yield* new DispatchError.Internal({
            source,
            tag: decoded._tag,
            reason: 'handler is undefined for an indexed tag',
          })
        }
        yield* handler(decoded)
        return undefined
      })

    interface QueueItem {
      readonly raw: string
      readonly source: DispatchError.Source
      readonly drainMarker?: Deferred.Deferred<void>
    }
    const queue = yield* Queue.unbounded<QueueItem>()

    yield* Effect.forkScoped(
      Stream.fromQueue(queue, { shutdown: true }).pipe(
        Stream.runForEach((item) =>
          item.drainMarker !== undefined
            ? Deferred.succeed(item.drainMarker, undefined).pipe(Effect.asVoid)
            : decodeAndDispatch(item.raw, item.source).pipe(
                Effect.catchAll(DispatchError.toLog),
                // Handler defects don't take the dispatch fiber down.
                Effect.catchAllDefect((defect) =>
                  Effect.logError(
                    `[effect-messaging] handler defect; dispatch continues: ${String(defect)}`
                  )
                )
              )
        )
      )
    )

    // After scope close the queue is shut down; `Effect.ignore` drops the resulting interrupt cleanly.
    const runtime = yield* Effect.runtime<never>()
    const enqueue = (raw: string): void => {
      Runtime.runSync(runtime)(Queue.offer(queue, { raw, source: 'live' }).pipe(Effect.ignore))
    }

    const initial = yield* adapter.drainInitial
    for (const raw of initial) {
      yield* Queue.offer(queue, { raw, source: 'initial' })
    }

    if (adapter.attachLive !== undefined) {
      yield* adapter.attachLive(enqueue)
    }

    /** Sentinel-marker drain: the dispatch fiber processes the marker after every prior message. */
    const flushed: Effect.Effect<void> = Effect.gen(function* () {
      const marker = yield* Deferred.make<void>()
      yield* Queue.offer(queue, { raw: '', source: 'live', drainMarker: marker })
      yield* Deferred.await(marker)
    })

    const sendMessage = (message: { readonly _tag: string }): Effect.Effect<void> =>
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

    const signalReady: Effect.Effect<void> =
      side === 'Web' ? adapter.bareSender(READY_RAW) : Effect.void

    return {
      // Runtime is `(m: {_tag: string}) => Effect<void>`; public type is the function-intersection.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      sendMessage: sendMessage as Bridge.SenderIntersection<Bridges, Side>,
      enqueue,
      flushed,
      signalReady,
    }
  })

export { make, READY_TAG }
export type { BridgeTransport }
