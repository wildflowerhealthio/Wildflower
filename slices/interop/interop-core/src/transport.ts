import type { Scope } from 'effect'
import { Effect, Queue, Runtime, Schema, Stream } from 'effect'
import type { BareSender } from './define-bridge.ts'
import {
  type AnyBridge,
  type BridgeSenderIntersection,
  type BridgeTransportLayers,
  type DispatchError,
  type DispatchSource,
  DisposedReceived,
  envelopeSchema,
  errorToLog,
  UnknownTag,
} from './dispatch.ts'

/**
 * Cross-platform transport core. Composes one or more bridges into a
 * single Effect program that:
 *
 * - Resolves each bridge's per-side handler record from its companion
 *   `Layer`, indexed by tuple position so misaligned counts/tags fail
 *   at compile time.
 * - Detects inbound-tag and outbound-tag collisions across bridges
 *   (duplicate declarations are a wiring mistake; the construction
 *   throws synchronously).
 * - Runs a forked dispatch fiber that consumes raw inbound strings
 *   from a `Queue`, decodes via a two-pass Schema check (envelope ⇒
 *   per-bridge specific), and routes to the matching handler. Failures
 *   are mapped through `errorToLog`, so the configured logger sees
 *   structured warnings instead of swallowed exceptions.
 * - Exposes a typed `sendMessage` (Effect-typed function intersection
 *   of every wired bridge's sender) and an `enqueue` callback the
 *   platform layer wires into its raw-message source (Web's
 *   `window.postMessage` listener, Expo's `<WebView onMessage>` prop).
 *
 * The whole program is `Effect<..., never, Scope>` — disposal happens
 * automatically when the scope closes (fiber interrupted, queue shut
 * down, any platform-attached resources released through their
 * `Effect.acquireRelease` chain). Callers compose with
 * `Effect.scoped(...)` and pass platform-specific glue via the
 * {@link PlatformAdapter}.
 *
 * Why a Queue + forked fiber: the platform-level subscription
 * (`addEventListener`, an RN `onMessage` prop) fires sync callbacks
 * outside Effect context. Pushing into a Queue from the sync sink and
 * letting a Stream-driven fiber pull lets the dispatch program inherit
 * the construction's context (logger, services) naturally — without
 * the runtime-capture + `Runtime.runSync` ceremony the previous
 * single-process boundary required.
 */

/**
 * Platform glue for {@link makeTransport}. Each platform package
 * supplies an adapter; the rest of the transport is shared.
 *
 * - {@link bareSender} writes one encoded string to the underlying
 *   surface (RN-WebView's `postMessage` on Web, the WebView ref's
 *   `postMessage` on Expo).
 * - {@link drainInitial} returns any pre-existing initial messages.
 *   Web's bundle reads `window.__INITIAL_MESSAGES__` and deletes the
 *   global so a hot reload doesn't double-replay; Expo has no
 *   pre-existing initials and returns an empty array.
 * - {@link attachLive} optionally wires the platform's live message
 *   source into the supplied `enqueue` callback. Web attaches a
 *   `window.addEventListener('message', ...)` and returns the
 *   detach. Expo doesn't attach a listener — it exposes `enqueue`
 *   directly on the transport (as `onMessage`) so the consumer can
 *   wire it to a `<WebView onMessage={...}>` prop.
 */
interface PlatformAdapter {
  readonly bareSender: BareSender
  readonly drainInitial: Effect.Effect<ReadonlyArray<string>>
  readonly attachLive?: (enqueue: (raw: string) => void) => Effect.Effect<void, never, Scope.Scope>
}

interface Transport<Bridges extends ReadonlyArray<AnyBridge>, Side extends 'Native' | 'Web'> {
  /**
   * Send any outbound message belonging to one of the wired bridges.
   * Returns an Effect; callers compose via `yield*` or
   * `Effect.flatMap`. TS resolves the call against the matching
   * bridge's overload; the runtime routes by `_tag` to the bridge that
   * owns it.
   */
  readonly sendMessage: BridgeSenderIntersection<Bridges, Side>
  /**
   * Push one raw inbound string into the dispatch fiber. Platform code
   * (Web's listener, Expo's `<WebView onMessage>` callback) calls this
   * from its sync entry. The sink is non-blocking; the fiber drains
   * asynchronously, inheriting the construction's Effect context.
   */
  readonly enqueue: (raw: string) => void
}

const makeTransport = <
  const Bridges extends ReadonlyArray<AnyBridge>,
  const Side extends 'Native' | 'Web',
>(config: {
  readonly bridges: Bridges
  readonly layers: BridgeTransportLayers<Bridges, Side>
  readonly side: Side
  readonly adapter: PlatformAdapter
}): Effect.Effect<Transport<Bridges, Side>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { bridges, layers, side, adapter } = config

    // Index handlers by bridge position. The I-th layer satisfies the
    // I-th bridge's HandlerTag, so each bridge's handlers record is
    // resolved independently — no merging required.
    type AnyHandlers = Readonly<Record<string, (message: unknown) => Effect.Effect<void>>>
    // Push *something* for every bridge slot, even if we couldn't
    // resolve a handlers record — silently `continue`-ing would shift
    // later bridges' handlers up by one slot, so a `tagToBridgeIndex`
    // result would index into the wrong bridge's handlers. Pushing
    // `undefined` keeps positions aligned and the `handlers === undefined`
    // check in the dispatch program is the same defensive guard for
    // both "internal misconfiguration" and "this slot intentionally has
    // no handlers".
    const handlersByBridgeIndex: Array<AnyHandlers | undefined> = []
    for (let i = 0; i < bridges.length; i++) {
      const bridge = bridges[i]
      const layer = layers[i]
      if (bridge === undefined || layer === undefined) {
        handlersByBridgeIndex.push(undefined)
        continue
      }
      // `Effect.provide(tag, layer)` resolves to the tag's service
      // value — the handlers record. Inside this generic body
      // `HandlerTag` is seen as `Tag<any, any>` (the bound's variance
      // escape, not the instantiation), so TS types `handlers` as
      // `any`. The runtime shape is the precise `HandlersFor<...>`
      // record from the layer.
      const half = bridge[side]
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const handlers = (yield* Effect.provide(half.HandlerTag, layer)) as AnyHandlers
      handlersByBridgeIndex.push(handlers)
    }

    // Detect inbound-tag collisions across bridges. Two bridges
    // declaring the same inbound `_tag` would silently route to
    // whichever was indexed last — a wiring mistake worth catching
    // loudly.
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
            `[interop] duplicate inbound tag "${tag}" across bridges "${existingBridge}" and "${bridge.name}"`
          )
        }
        tagToBridgeIndex.set(tag, i)
      }
    }

    // Map each outbound tag to its bridge's typed sender. Cross-bridge
    // collisions are detected and thrown, mirroring the inbound check.
    type TaggedSender = (message: { readonly _tag: string }) => Effect.Effect<void>
    const senderByTag = new Map<string, TaggedSender>()
    for (const bridge of bridges) {
      const half = bridge[side]
      const sender = half.makeSender(adapter.bareSender)
      for (const tag of Object.keys(half.OutboundSchemas)) {
        if (senderByTag.has(tag)) {
          throw new Error(`[interop] duplicate outbound tag "${tag}" across bridges`)
        }
        // `sender` is typed `(m: never) => Effect<void>` per the
        // bound — the contravariant escape that admits both
        // empty-outbound and populated-outbound bridges. The runtime
        // function accepts the concrete outbound union for its
        // bridge; the dispatch loop routes by `_tag` so each call
        // lands on a sender that does accept that message at runtime.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        senderByTag.set(tag, sender as TaggedSender)
      }
    }

    let disposed = false

    /**
     * Decode one raw inbound message and route it to the owning
     * bridge's handler. Returns an Effect that fails with one of the
     * three structured {@link DispatchError} variants — `ParseError`
     * (any Schema rejection), `UnknownTag` (well-formed envelope, tag
     * not wired), or `DisposedReceived`.
     *
     * Two-step decode: envelope (`{_tag: string}`) extracts the tag and
     * surfaces malformed inputs as `ParseError`; the per-bridge schema
     * then validates the full payload (`ParseError` again on shape
     * mismatch).
     */
    const decodeAndDispatch = (
      raw: string,
      source: DispatchSource
    ): Effect.Effect<void, DispatchError> =>
      Effect.gen(function* () {
        if (disposed) return yield* new DisposedReceived({ source })

        const { _tag } = yield* Schema.decode(envelopeSchema)(raw)

        const bridgeIndex = tagToBridgeIndex.get(_tag)
        if (bridgeIndex === undefined) return yield* new UnknownTag({ source, tag: _tag })

        const bridge = bridges[bridgeIndex]
        const handlers = handlersByBridgeIndex[bridgeIndex]
        if (bridge === undefined || handlers === undefined) {
          // Internal misconfiguration: the tag indexed but the bridge
          // or handlers slot is missing. The dup check above has
          // enforced the happy path's invariants, so this is a hard
          // internal bug. Drop silently.
          return undefined
        }
        const half = bridge[side]
        const schema = half.InboundSchemas[_tag]
        if (schema === undefined) return undefined

        const decoded: unknown = yield* Schema.decodeUnknown(schema)(raw)

        const handler = handlers[_tag]
        if (handler !== undefined) yield* handler(decoded)
        return undefined
      })

    // The Queue-and-fiber pattern bridges the platform-level sync
    // callback (sync `MessageEvent` handler, sync `onMessage` prop)
    // into the Effect-typed dispatch program. The fiber inherits this
    // construction's context (logger, services), so log calls inside
    // the dispatch program propagate naturally — no runtime capture
    // needed.
    const queue = yield* Queue.unbounded<{
      readonly raw: string
      readonly source: DispatchSource
    }>()

    yield* Effect.forkScoped(
      Stream.fromQueue(queue).pipe(
        Stream.runForEach(({ raw, source }) =>
          decodeAndDispatch(raw, source).pipe(Effect.catchAll(errorToLog))
        )
      )
    )

    // Capture the runtime *only* for the platform's sync sink, which
    // can't yield into the queue's Effect API directly. The runtime
    // inherits this gen's context, so `Runtime.runSync(runtime)(
    // queue.offer(...))` lands the message on the same logger / services
    // the fiber sees.
    const runtime = yield* Effect.runtime<never>()
    const enqueue = (raw: string): void => {
      Runtime.runSync(runtime)(Queue.offer(queue, { raw, source: 'live' }))
    }

    // Drain pre-existing initial messages through the same dispatch
    // program. Synchronous wrt this gen body; the platform-specific
    // step (Web's window-global read + delete; Expo's empty array)
    // happens inside the adapter's Effect.
    const initial = yield* adapter.drainInitial
    for (const raw of initial) {
      yield* Queue.offer(queue, { raw, source: 'initial' })
    }

    // Optional live attachment. Web's adapter attaches a window
    // listener (acquireRelease detaches on scope close); Expo's
    // adapter doesn't attach anything — the consumer wires `enqueue`
    // to the WebView's onMessage prop manually.
    if (adapter.attachLive !== undefined) {
      yield* adapter.attachLive(enqueue)
    }

    // Mark disposed once the scope closes (fiber interrupted; queue
    // shut down by Effect.forkScoped). The flag prevents
    // dispatch-from-late-callbacks scenarios where a sync handler
    // fires post-close before the listener detach lands.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        disposed = true
      })
    )

    const sendMessage = (message: { readonly _tag: string }): Effect.Effect<void> =>
      Effect.gen(function* () {
        const sender = senderByTag.get(message._tag)
        if (sender === undefined) {
          yield* Effect.logWarning(
            `[interop] sendMessage: no bridge owns tag "${message._tag}"; dropping`
          )
          return undefined
        }
        yield* sender(message)
        return undefined
      })

    return {
      // The runtime sender is structurally
      // `(m: {_tag: string}) => Effect<void>`; the public type is the
      // function-intersection of every wired bridge's typed sender. TS
      // does not synthesise overload-intersections from a
      // union-argument implementation, so the cast is unavoidable.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      sendMessage: sendMessage as BridgeSenderIntersection<Bridges, Side>,
      enqueue,
    }
  })

export { makeTransport }
export type { PlatformAdapter, Transport }
