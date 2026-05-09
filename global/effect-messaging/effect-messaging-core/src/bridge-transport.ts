import type { Scope } from 'effect'
import { Deferred, Effect, Queue, Runtime, Schema, Stream } from 'effect'
import * as Bridge from './bridge.ts'
import * as DispatchError from './dispatch-error.ts'
import * as Message from './message.ts'
import { PlatformAdapter } from './platform-adapter.ts'

/**
 * Cross-platform bridge transport. Composes one or more
 * {@link Bridge.Bridge} declarations into a single Effect program
 * with a typed `sendMessage`, an `enqueue` for the platform's raw
 * inbound source, and a `flushed` Effect for tests to await the
 * dispatch fiber's drain point.
 *
 * @remarks
 * Disposal is automatic: scope close shuts down the queue (via
 * `Stream.fromQueue`'s `shutdown: true`), interrupts the forked
 * dispatch fiber, and detaches platform listeners through their
 * `Effect.acquireRelease` chain. Re-exported as the
 * `BridgeTransport` namespace from `effect-messaging-core`'s
 * barrel.
 */

interface BridgeTransport<
  Bridges extends ReadonlyArray<Bridge.AnyBridge>,
  Side extends 'Host' | 'Web',
> {
  /** Send any outbound message belonging to one of the wired bridges. */
  readonly sendMessage: Bridge.SenderIntersection<Bridges, Side>
  /**
   * Push one raw inbound string into the dispatch fiber. Platform
   * code (Web's listener, Expo's `<WebView onMessage>` callback)
   * calls this from its sync entry. After scope close the call is a
   * no-op — the queue is shut down and the late call drops cleanly.
   */
  readonly enqueue: (raw: string) => void
  /**
   * Resolves once the dispatch fiber has drained every message
   * enqueued before the call. Tests use this in place of
   * `Effect.sleep(0)` to wait for a deterministic drain point.
   */
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

    // Resolve each bridge's handler record from its companion layer,
    // indexed by tuple position. `undefined` slots keep positions
    // aligned with `tagToBridgeIndex`.
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

    // Inbound-tag uniqueness check across bridges. Two bridges
    // declaring the same `_tag` would silently route to whichever was
    // indexed last — surfaced as a wiring mistake.
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

    // Outbound senders, indexed by tag. The helper throws on
    // cross-bridge tag collisions — same wiring-error policy as the
    // inbound dup check above.
    const taggedSenders = Bridge.senderByTag(bridges, side)

    /**
     * Decode one raw inbound message and route it to the owning
     * bridge's handler.
     *
     * @remarks
     * One-pass JSON parse via {@link Message.wireRoutingEnvelope} to
     * extract the `_tag`. Successful envelope decode gives us a typed
     * `_tag`; unknown tags surface as {@link DispatchError.UnknownTag}.
     * Known tags route to the per-bridge schema's full decode, which
     * re-parses the JSON internally — Effect's Schema doesn't expose
     * a "decode-from-already-parsed" path for `parseJson`-wrapped
     * schemas without unwrapping them. The redundant JSON.parse is
     * cheap relative to the structured-error distinction it preserves
     * (see thread 3210718306 in the PR for the trade-off analysis).
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
                // Defects (handler `Effect.die(...)`, etc.) are
                // logged but don't take the dispatch fiber down.
                Effect.catchAllDefect((defect) =>
                  Effect.logWarning(
                    `[effect-messaging] handler defect; dispatch continues: ${String(defect)}`
                  )
                )
              )
        )
      )
    )

    // Sync entry for the platform's listener / onMessage callback.
    // After scope close the queue is shut down (Stream.fromQueue's
    // `shutdown: true`); the offer is wrapped in `Effect.ignore` so a
    // shutdown-induced interrupt drops cleanly rather than throwing
    // out of the sync sink.
    const runtime = yield* Effect.runtime<never>()
    const enqueue = (raw: string): void => {
      Runtime.runSync(runtime)(
        Queue.offer(queue, { raw, source: 'live' }).pipe(Effect.ignore)
      )
    }

    // Drain pre-existing initial messages through the same dispatch
    // program. The platform-specific step (Web's window-global read +
    // delete; Expo's empty array) happens inside the adapter Effect.
    const initial = yield* adapter.drainInitial
    for (const raw of initial) {
      yield* Queue.offer(queue, { raw, source: 'initial' })
    }

    // Optional live attachment. Web's adapter wires
    // `window.addEventListener('message', ...)`; Expo's adapter omits
    // this (the consumer wires `onMessage` to the WebView prop).
    if (adapter.attachLive !== undefined) {
      yield* adapter.attachLive(enqueue)
    }

    /**
     * Enqueue a sentinel marker and wait until the dispatch fiber has
     * processed it — every prior message has resolved by the time
     * the marker fires.
     */
    const flushed: Effect.Effect<void> = Effect.gen(function* () {
      const marker = yield* Deferred.make<void>()
      yield* Queue.offer(queue, { raw: '', source: 'live', drainMarker: marker })
      yield* Deferred.await(marker)
    })

    // Internal senders require {@link PlatformAdapter} from context.
    // The transport satisfies that requirement here so the public
    // `sendMessage` exposes a plain `Effect<void>`.
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
      // The runtime sender is structurally `(m: {_tag: string}) =>
      // Effect<void>`; the public type is the function-intersection of
      // every wired bridge's typed sender. TS does not synthesise
      // overload-intersections from a union-argument implementation.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      sendMessage: sendMessage as Bridge.SenderIntersection<Bridges, Side>,
      enqueue,
      flushed,
    }
  })

export { make }
export type { BridgeTransport }
