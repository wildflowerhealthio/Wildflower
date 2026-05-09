import type { Scope } from 'effect'
import { Deferred, Effect, Queue, Runtime, Schema, Stream } from 'effect'
import * as Bridge from './bridge.ts'
import * as DispatchError from './dispatch-error.ts'
import * as Message from './message.ts'
import { PlatformAdapter } from './platform-adapter.ts'

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
  /** Send any outbound message belonging to one of the wired bridges. */
  readonly sendMessage: Bridge.SenderIntersection<Bridges, Side>
  /**
   * Push one raw inbound string into the dispatch fiber. After scope
   * close the call is a no-op (the queue is shut down).
   */
  readonly enqueue: (raw: string) => void
  /** Resolves once the dispatch fiber has drained every message enqueued before the call. */
  readonly flushed: Effect.Effect<void>
}

const make = <
  const Bridges extends ReadonlyArray<Bridge.AnyBridge>,
  const Side extends 'Host' | 'Web',
>(config: {
  readonly bridges: Bridges
  readonly layers: Bridge.TransportLayers<Bridges, Side>
  readonly side: Side
}): Effect.Effect<BridgeTransport<Bridges, Side>, never, PlatformAdapter | Scope.Scope> =>
  Effect.gen(function* () {
    const { bridges, layers, side } = config
    const adapter = yield* PlatformAdapter

    type AnyHandlers = Readonly<Record<string, (message: unknown) => Effect.Effect<void>>>
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

    // Inbound-tag uniqueness check: duplicate `_tag`s would silently route to whichever was indexed last.
    const tagToBridgeIndex = new Map<string, number>()
    for (let i = 0; i < bridges.length; i++) {
      const bridge = bridges[i]
      if (bridge === undefined) continue
      const half = bridge[side]
      for (const tag of Object.keys(half.InboundSchemas)) {
        const existing = tagToBridgeIndex.get(tag)
        if (existing !== undefined) {
          const existingBridge = bridges[existing]?.name ?? '?'
          throw new Error(
            `[effect-messaging] duplicate inbound tag "${tag}" across bridges "${existingBridge}" and "${bridge.name}"`
          )
        }
        tagToBridgeIndex.set(tag, i)
      }
    }

    const taggedSenders = Bridge.senderByTag(bridges, side)

    /**
     * Decode one raw inbound message and route it to the owning bridge's handler.
     *
     * @remarks
     * One-pass envelope decode to extract the `_tag`; the per-bridge
     * schema then re-parses the JSON. Effect's Schema doesn't expose a
     * "decode-from-already-parsed" path for `parseJson`-wrapped schemas;
     * the redundant `JSON.parse` is cheap relative to the structured-error
     * distinction (`UnknownTag` vs payload-parse failure).
     */
    const decodeAndDispatch = (
      raw: string,
      source: DispatchError.Source
    ): Effect.Effect<void, DispatchError.DispatchError> =>
      Effect.gen(function* () {
        const { _tag } = yield* Schema.decode(Message.wireRoutingEnvelope)(raw)

        const bridgeIndex = tagToBridgeIndex.get(_tag)
        if (bridgeIndex === undefined)
          return yield* new DispatchError.UnknownTag({ source, tag: _tag })

        const bridge = bridges[bridgeIndex]
        const handlers = handlersByBridgeIndex[bridgeIndex]
        if (bridge === undefined) {
          return yield* new DispatchError.Internal({
            source,
            tag: _tag,
            reason: 'bridge slot is undefined for an indexed tag',
          })
        }
        if (handlers === undefined) {
          return yield* new DispatchError.Internal({
            source,
            tag: _tag,
            reason: 'handlers slot is undefined for an indexed tag',
          })
        }
        const half = bridge[side]
        const schema = half.InboundSchemas[_tag]
        if (schema === undefined) {
          return yield* new DispatchError.Internal({
            source,
            tag: _tag,
            reason: 'inbound schema is undefined for an indexed tag',
          })
        }

        const decoded: unknown = yield* Schema.decodeUnknown(schema)(raw)

        const handler = handlers[_tag]
        if (handler === undefined) {
          return yield* new DispatchError.Internal({
            source,
            tag: _tag,
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
                  Effect.logWarning(
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
      Runtime.runSync(runtime)(
        Queue.offer(queue, { raw, source: 'live' }).pipe(Effect.ignore)
      )
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
        const sender = taggedSenders.get(message._tag)
        if (sender === undefined) {
          yield* Effect.logWarning(
            `[effect-messaging] sendMessage: no bridge owns tag "${message._tag}"; dropping`
          )
          return undefined
        }
        yield* sender(message)
        return undefined
      }).pipe(Effect.provideService(PlatformAdapter, adapter))

    return {
      // Runtime is `(m: {_tag: string}) => Effect<void>`; public type is the function-intersection.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      sendMessage: sendMessage as Bridge.SenderIntersection<Bridges, Side>,
      enqueue,
      flushed,
    }
  })

export { make }
export type { BridgeTransport }
