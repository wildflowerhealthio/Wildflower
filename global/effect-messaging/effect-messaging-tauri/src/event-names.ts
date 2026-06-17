/**
 * Tauri event name for the single multiplexed bridge channel. Every
 * wired bridge — across both directions — emits and listens on this
 * single name; the discriminator is the `_tag` field inside the
 * payload, which every bridge message already carries by construction.
 *
 * @remarks
 * The per-tag scheme (`bridge:{tag}`) was retired because Tauri's event
 * bus only guarantees FIFO *within* a single event name. With a tag per
 * channel, a streaming sender's `ResponseFinished` could land at the
 * receiver before the in-flight `ResponseData` chunks, because each
 * cross-tag delivery is its own `webview.eval(__TAURI_INTERNALS__.runCallback(...))`
 * injection on the receiver and Tauri makes no inter-injection ordering
 * promise. One channel = strict FIFO across every tag the protocol
 * uses, which is what the sniffer's chunked page-content stream relies
 * on.
 *
 * The Rust host must listen/emit with the same literal; both sides pin
 * it with a test (TS: `event-names.test.ts`; Rust: the host crate's
 * bridge module) so drift breaks a build instead of a runtime
 * handshake. Tauri accepts alphanumeric event names plus `-`, `/`, `:`,
 * `_`; the bare `bridge` literal is well within that.
 */
const BRIDGE_EVENT = 'bridge'

/**
 * Web→host readiness tag. The web side emits a payload with this
 * `_tag` once every inbound listener is attached; the host's bridge
 * listener watches for this tag and replies with its boot-time state
 * (e.g. the gatekeeper's `AuthTokenIssued`). Same `__Ready` literal as
 * effect-messaging-core's transport handshake — kept as a tag rather
 * than its own event name so it travels through the same single
 * channel as everything else.
 */
const READY_TAG = '__Ready'

export { BRIDGE_EVENT, READY_TAG }
