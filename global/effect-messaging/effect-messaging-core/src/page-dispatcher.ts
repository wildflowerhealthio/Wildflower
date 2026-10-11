import type { ParseResult } from 'effect'
import { Cause, Effect, Queue, Schema, Stream } from 'effect'
import type * as Bridge from './bridge.ts'
import type { BridgeHandlerRecord, HandlerCoordinator } from './handler-coordinator.ts'
import { warnAboutDroppedTag } from './handler-helpers.ts'
import { assertUniqueTags } from './internal/assert-unique-tags.ts'
import type * as MessageHandler from './message-handler.ts'
import type * as Message from './message.ts'

/**
 * Boot-stable handler seed, keyed by bridge name and typed per bridge:
 * a key must be a wired bridge's name and its value that bridge's own
 * `HostToWeb` handler record — a typo'd name or a record from the
 * wrong bridge is a compile error at the call site.
 */
type InitialHandlers<Bridges extends ReadonlyArray<Bridge.AnyBridge>> = {
  readonly [B in Bridges[number] as B['name']]?: MessageHandler.HandlersFor<B['HostToWeb']>
}

/**
 * Config object accepted by {@link make}.
 *
 * @typeParam Bridges - the wired bridge tuple the dispatcher serves.
 */
interface PageDispatcherConfig<Bridges extends ReadonlyArray<Bridge.AnyBridge>> {
  /**
   * The wired bridge tuple; inbound tags are collected from each
   * bridge's `HostToWeb` record. Throws on a tag shared by two bridges
   * or directions, or one claiming the reserved `__Ready` tag.
   */
  readonly bridges: Bridges
  /**
   * Boot-stable handler records keyed by bridge name. Bridges absent
   * here warn-and-drop until a slice registers on mount.
   */
  readonly initial?: InitialHandlers<Bridges>
}

/**
 * The page side of a bridge channel, independent of what carries it: a
 * transport feeds every inbound payload to `offer` and hands
 * `coordinator` to the app.
 */
interface PageDispatcher {
  /**
   * Hand one inbound payload (a structured value, not a wire string) to
   * the dispatcher. Synchronous and order-preserving: payloads dispatch
   * in `offer` call order. Payloads without a string `_tag`, or whose
   * `_tag` no wired bridge declares inbound (a `WebToHost` echo of the
   * page's own send, a sibling bridge's traffic), are dropped silently.
   */
  readonly offer: (payload: unknown) => void
  /**
   * Per-bridge inbound handler registration: last-writer-wins
   * `register`, set-if-equal `unregister`, warn-and-drop for
   * unregistered bridges — so slice `makeUseSliceRegister` hooks work
   * unchanged.
   */
  readonly coordinator: HandlerCoordinator
}

/**
 * Build the page-side dispatcher for a set of bridges.
 *
 * @remarks
 * Demuxes each offered payload by `_tag` through a dispatch table built
 * once from the bridges' `HostToWeb` records. Each payload is validated
 * against the bridge schema's struct side (`Schema.typeSchema` — the
 * bridge schemas stay the wire authority even when no JSON string
 * crosses the transport) and routed to the bridge's record active *at
 * dispatch time*, so coordinator swaps take effect without the transport
 * re-listening. Undecodable payloads, tags with no registered handler,
 * and handler defects are logged and dropped; the next payload
 * dispatches normally.
 *
 * Every payload is funnelled through one unbounded queue drained by a
 * single fiber (as in core's host-side inbound dispatcher), so payloads
 * apply in arrival order across every tag even when a handler suspends —
 * no per-payload fiber can overtake an earlier one.
 *
 * The dispatcher lives for the page's lifetime; its fiber is never
 * interrupted.
 *
 * @param config - see {@link PageDispatcherConfig}.
 */
const make = <const Bridges extends ReadonlyArray<Bridge.AnyBridge>>(
  config: PageDispatcherConfig<Bridges>
): PageDispatcher => {
  assertUniqueTags(config.bridges)
  // Widening seam: every `InitialHandlers` value is some bridge's typed
  // `HandlersFor` record, all of which erase to `BridgeHandlerRecord`
  // by parameter contravariance — provable at any concrete
  // instantiation, but opaque to the checker while `Bridges` is
  // generic, hence the one-off assertion.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const seed = (config.initial ?? {}) as Readonly<Record<string, BridgeHandlerRecord>>
  const active = new Map<string, BridgeHandlerRecord>(Object.entries(seed))

  // One dispatch program per (bridge, tag): validate the structured
  // payload, then route to whatever record is active at dispatch time.
  const dispatchFor = (
    bridgeName: string,
    tag: string,
    schema: Message.AnyStringEncodedSchema
  ): ((payload: unknown) => Effect.Effect<void>) => {
    // Pinned to the decoded floor shape so `AnyStringEncodedSchema`'s
    // `any` stops here instead of flowing into the handler call.
    const decodePayload: (
      payload: unknown
    ) => Effect.Effect<MessageHandler.DecodedMessage, ParseResult.ParseError> =
      Schema.decodeUnknown(Schema.typeSchema(schema))
    return (payload) =>
      decodePayload(payload).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.logWarning(
              `[effect-messaging] undecodable inbound ${tag} payload dropped: ${String(error)}`
            ),
          onSuccess: (message) => {
            const handler = active.get(bridgeName)?.[tag]
            if (handler === undefined) {
              return warnAboutDroppedTag(bridgeName, tag)
            }
            // `message` was just validated by the same
            // `bridge.HostToWeb[tag]` schema this handler's parameter
            // type was derived from (`HandlersFor`) — every write path
            // into `active` pairs a bridge with its own record, so the
            // value matches the handler by construction; the
            // string-keyed registry just can't carry that correlation
            // in types. Independently pinned by the delivery and
            // validation tests in page-dispatcher.test.ts.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            return handler(message as never)
          },
        }),
        Effect.catchAllCause((cause) =>
          Effect.logError(
            `[effect-messaging] inbound ${tag} handler died; continuing: ${Cause.pretty(cause)}`
          )
        )
      )
  }

  // Single-consumer inbox: every offered payload enqueues its
  // already-bound dispatch program onto one unbounded queue, drained by a
  // single forked fiber. Forking a fiber *per payload* would let an async
  // handler on an earlier payload be overtaken by a later one, so two
  // rapid pushes could apply out of order; funnelling through one
  // consumer pins FIFO across handler suspensions. Each queued program
  // carries its own error/defect handling (see `dispatchFor`), so a bad
  // message never takes the consumer down.
  const inbox = Queue.unbounded<Effect.Effect<void>>().pipe(Effect.runSync)
  Effect.runFork(Stream.runForEach(Stream.fromQueue(inbox), (program) => program))

  // Single-tag dispatch table: every wired bridge's `HostToWeb` entry
  // contributes one `(tag → dispatch)` row keyed by the message's
  // discriminator. Tags are unique across bridges and directions by
  // `assertUniqueTags`.
  const dispatchByTag = new Map<string, (payload: unknown) => Effect.Effect<void>>()
  for (const bridge of config.bridges) {
    for (const [tag, schema] of Object.entries(bridge.HostToWeb)) {
      dispatchByTag.set(tag, dispatchFor(bridge.name, tag, schema))
    }
  }

  const offer = (payload: unknown): void => {
    if (payload === null || typeof payload !== 'object' || !('_tag' in payload)) return
    const tag = payload._tag
    if (typeof tag !== 'string') return
    const dispatch = dispatchByTag.get(tag)
    if (dispatch === undefined) return
    // Synchronous, order-preserving handoff: unsafe-offering in call
    // order is what makes the single consumer FIFO.
    inbox.unsafeOffer(dispatch(payload))
  }

  // Implementations are typed against the erased structural shapes;
  // the `HandlerCoordinator` annotation below is where TS verifies
  // them against the generic interface (instantiated at its
  // constraint) — no casts needed on the write path.
  const register = (bridge: Bridge.AnyBridge, handlers: BridgeHandlerRecord): Effect.Effect<void> =>
    Effect.sync(() => {
      active.set(bridge.name, handlers)
    })

  const unregister = (
    bridge: Bridge.AnyBridge,
    handlers: BridgeHandlerRecord
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      if (active.get(bridge.name) === handlers) {
        active.delete(bridge.name)
      }
    })

  const coordinator: HandlerCoordinator = { register, unregister }

  return { offer, coordinator }
}

export { make }
export type { InitialHandlers, PageDispatcher, PageDispatcherConfig }
