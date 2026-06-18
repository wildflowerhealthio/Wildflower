import { emit, listen } from '@tauri-apps/api/event'
import type { ParseResult } from 'effect'
import { Cause, Effect, Queue, Schema, Stream } from 'effect'
import type {
  Bridge,
  BridgeHandlerRecord,
  BridgeTransport,
  HandlerCoordinator,
  Message,
  MessageHandler,
} from 'effect-messaging-core'
import { HandlerHelpers } from 'effect-messaging-core'

import { BRIDGE_EVENT, READY_TAG } from './event-names.ts'

/**
 * The slice of Tauri's event API the transport consumes, structurally
 * narrowed so tests can inject a plain fake without reproducing
 * `@tauri-apps/api`'s generics. The real `emit`/`listen` satisfy it.
 */
interface TauriEventApi {
  readonly emit: (event: string, payload?: unknown) => Promise<void>
  readonly listen: (
    event: string,
    handler: (event: { readonly payload: unknown }) => void
  ) => Promise<() => void>
}

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
 * Config object accepted by {@link makeTauriTransport}.
 *
 * @typeParam Bridges - the wired bridge tuple this transport will serve.
 */
interface TauriTransportConfig<Bridges extends ReadonlyArray<Bridge.AnyBridge>> {
  /**
   * The wired bridge tuple; inbound tags are collected from each
   * bridge's `HostToWeb` record. Rejects on a tag shared by two bridges
   * or directions (see {@link assertUniqueTags}).
   */
  readonly bridges: Bridges
  /**
   * Boot-stable handler records keyed by bridge name. Bridges absent
   * here warn-and-drop until a slice registers on mount.
   */
  readonly initial?: InitialHandlers<Bridges>
  /**
   * Injected event functions for tests; defaults to
   * `@tauri-apps/api/event`'s `emit`/`listen`.
   */
  readonly api?: TauriEventApi
}

/**
 * The Tauri-native bridge transport: the same `sendMessage` +
 * `coordinator` seam the React app consumes (`ReactTransport`), with no
 * string envelope underneath — every message rides the single
 * `BRIDGE_EVENT` Tauri event as a structured payload, with the
 * message's `_tag` field acting as the dispatch discriminator on the
 * receiving side.
 */
interface TauriTransport<Bridges extends ReadonlyArray<Bridge.AnyBridge>> {
  /**
   * Emit an outbound (web→host) message on its per-tag Tauri event.
   * Emit failures are logged and dropped — sending never fails the
   * caller, mirroring the postMessage transports' behavior.
   */
  readonly sendMessage: BridgeTransport.MessageSender<Bridges, 'WebToHost'>
  /**
   * Per-bridge inbound handler registration with the same semantics as
   * `makeHandlerCoordinator` (last-writer-wins `register`, set-if-equal
   * `unregister`, drop-all-with-warn for unregistered bridges) — so
   * slice `makeUseSliceRegister` hooks work unchanged.
   */
  readonly coordinator: HandlerCoordinator
}

/**
 * Tags discriminate dispatch inside the single multiplexed Tauri event,
 * and Tauri events broadcast to every listener — including the
 * emitting webview itself. So tags must be unique across every wired
 * bridge and across *both* directions (a tag in one bridge's
 * `HostToWeb` and another's `WebToHost` would make the web receive its
 * own sends), and must not shadow the reserved `__Ready` handshake
 * tag. Stricter than the core transport's per-direction
 * `assertNoDuplicateTags`, because the multiplexed channel is
 * direction-less. Throws at build time, before any listener attaches.
 *
 * @remarks
 * **Cross-process collision domain.** This check only sees the bridges
 * passed to *this* transport. The `bridge` Tauri channel is shared
 * with every other listener in the app (the main TS transport, raw
 * sniffer webviews, every Rust `app.listen(BRIDGE_EVENT, …)` in
 * `wildflower-tauri` / `browser-sniffer-tauri-rust` / future host
 * crates). A tag added to a sibling listener with the same name will
 * NOT throw here — instead, both listeners will receive every emit
 * for that tag and dispatch independently. Whenever you introduce a
 * new tag on the bridge channel, manually grep every listener
 * (`match tag.as_str` arms under `src-tauri/src/` and each
 * `<name>-tauri-rust/src/`, plus every TS bridge declaration under
 * `<name>-core/src/bridge.ts`) and confirm the literal is unused.
 * There is no automated cross-process guard. See the
 * `effect-messaging-tauri` README "Tag uniqueness across processes"
 * section for the longer write-up.
 */
const assertUniqueTags = (bridges: ReadonlyArray<Bridge.AnyBridge>): void => {
  const owners = new Map<string, string>([[READY_TAG, 'the reserved __Ready handshake tag']])
  for (const bridge of bridges) {
    for (const direction of ['HostToWeb', 'WebToHost'] as const) {
      for (const tag of Object.keys(bridge[direction])) {
        const owner = owners.get(tag)
        if (owner !== undefined) {
          throw new Error(
            `[effect-messaging] tag "${tag}" on bridge "${bridge.name}" (${direction}) collides with ${owner} — tags name Tauri events and must be unique across bridges and directions`
          )
        }
        owners.set(tag, `bridge "${bridge.name}" (${direction})`)
      }
    }
  }
}

/**
 * Build the web-side bridge transport for a Tauri host.
 *
 * @remarks
 * Inbound: one Tauri `listen` per `HostToWeb` tag across the wired
 * tuple, attached before anything else. Each payload is validated
 * against the bridge schema's struct side (`Schema.typeSchema` — the
 * bridge schemas stay the wire authority even though no JSON string
 * crosses this transport) and routed to the bridge's *current* handler
 * record. Undecodable payloads and handler defects are logged and
 * dropped; the next event dispatches normally. Every inbound event is
 * funnelled through one unbounded queue drained by a single fiber (as in
 * core's `makeInboundDispatcher`), so same-tag events apply in arrival
 * order even when a handler suspends — no per-event fiber can overtake an
 * earlier one.
 *
 * Readiness: once **all** listeners have attached, `bridge:__Ready` is
 * emitted — only then may the host respond, so its first message (e.g.
 * the gatekeeper token) cannot race listener setup and vanish (Tauri
 * events are not buffered). The host re-receives `__Ready` on every
 * page load, so reloads re-trigger its boot-state push. The resolved
 * Promise therefore has the same meaning as the postMessage
 * transports' `signalReady`.
 *
 * The transport lives for the page's lifetime — listeners are never
 * detached (page teardown drops them with the document).
 *
 * @param config - see {@link TauriTransportConfig}.
 */
const makeTauriTransport = async <const Bridges extends ReadonlyArray<Bridge.AnyBridge>>(
  config: TauriTransportConfig<Bridges>
): Promise<TauriTransport<Bridges>> => {
  assertUniqueTags(config.bridges)
  const api = config.api ?? { emit, listen }
  // Widening seam: every `InitialHandlers` value is some bridge's typed
  // `HandlersFor` record, all of which erase to `BridgeHandlerRecord`
  // by parameter contravariance — provable at any concrete
  // instantiation, but opaque to the checker while `Bridges` is
  // generic, hence the one-off assertion.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const seed = (config.initial ?? {}) as Readonly<Record<string, BridgeHandlerRecord>>
  const active = new Map<string, BridgeHandlerRecord>(Object.entries(seed))

  const sendMessage: BridgeTransport.MessageSender<Bridges, 'WebToHost'> = (message) =>
    Effect.tryPromise(() => api.emit(BRIDGE_EVENT, message)).pipe(
      Effect.catchAll((error) =>
        Effect.logWarning(
          `[effect-messaging] tauri emit for ${message._tag} failed; message dropped: ${String(error)}`
        )
      ),
      Effect.asVoid
    )

  // One dispatch program per (bridge, tag): validate the structured
  // payload, then route to whatever record is active *at dispatch time*
  // (so coordinator swaps take effect without re-listening).
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
              `[effect-messaging] undecodable ${BRIDGE_EVENT} ${tag} payload dropped: ${String(error)}`
            ),
          onSuccess: (message) => {
            const handler = active.get(bridgeName)?.[tag]
            if (handler === undefined) {
              return HandlerHelpers.warnAboutDroppedTag(bridgeName, tag)
            }
            // `message` was just validated by the same
            // `bridge.HostToWeb[tag]` schema this handler's parameter
            // type was derived from (`HandlersFor`) — every write path
            // into `active` pairs a bridge with its own record, so the
            // value matches the handler by construction; the
            // string-keyed registry just can't carry that correlation
            // in types. Independently pinned by the delivery and
            // validation tests in tauri-transport.test.ts.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            return handler(message as never)
          },
        }),
        Effect.catchAllCause((cause) =>
          Effect.logError(
            `[effect-messaging] ${BRIDGE_EVENT} ${tag} handler died; continuing: ${Cause.pretty(cause)}`
          )
        )
      )
  }

  // Single-consumer inbox, mirroring the core transport's inbound
  // dispatcher (`makeInboundDispatcher`): every Tauri event offers its
  // already-bound dispatch program onto one unbounded queue, drained by a
  // single forked fiber. Forking a fiber *per event* would let an async
  // handler on an earlier event be overtaken by a later event's fiber, so
  // two rapid pushes on the same tag could apply out of order; funnelling
  // through one consumer pins FIFO across handler suspensions, matching the
  // postMessage transports. Each queued program carries its own
  // error/defect handling (see `dispatchFor`), so a bad message never
  // takes the consumer down.
  const inbox = Queue.unbounded<Effect.Effect<void>>().pipe(Effect.runSync)
  Effect.runFork(Stream.runForEach(Stream.fromQueue(inbox), (program) => program))

  // Single-tag dispatch table: every wired bridge's `HostToWeb` entry
  // contributes one `(tag → dispatch)` row keyed by the message's
  // discriminator. Built once at attach time; the single listener
  // below looks up the row per inbound message. Tags are guaranteed
  // unique across bridges and directions by `assertUniqueTags`.
  const dispatchByTag = new Map<string, (payload: unknown) => Effect.Effect<void>>()
  for (const bridge of config.bridges) {
    for (const [tag, schema] of Object.entries(bridge.HostToWeb)) {
      dispatchByTag.set(tag, dispatchFor(bridge.name, tag, schema))
    }
  }

  // One listener for the entire bridge channel; demux by the payload's
  // `_tag` field. Unknown tags (a `WebToHost` echo of our own emit, a
  // sibling bridge's traffic we don't subscribe to, or a malformed
  // payload) are dropped silently. Per-tag listeners would let Tauri
  // re-order events across tags (see BRIDGE_EVENT's docstring): one
  // listener pins FIFO across the whole protocol, which the sniffer's
  // chunked page-content stream depends on.
  await api.listen(BRIDGE_EVENT, (event) => {
    const payload = event.payload
    if (payload === null || typeof payload !== 'object' || !('_tag' in payload)) return
    const tag = (payload as { readonly _tag: unknown })._tag
    if (typeof tag !== 'string') return
    const dispatch = dispatchByTag.get(tag)
    if (dispatch === undefined) return
    // Synchronous, order-preserving handoff: the listener fires on
    // the JS event loop, so unsafe-offering in call order is what
    // makes the single consumer FIFO.
    inbox.unsafeOffer(dispatch(payload))
  })

  // Every inbound listener is up — only now may the host learn we're
  // ready (its response could otherwise beat the listeners and vanish).
  await api.emit(BRIDGE_EVENT, { _tag: READY_TAG })

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

  return { sendMessage, coordinator }
}

export { makeTauriTransport }
export type { InitialHandlers, TauriEventApi, TauriTransport, TauriTransportConfig }
