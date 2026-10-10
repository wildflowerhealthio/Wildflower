/**
 * Tauri event name for the single multiplexed bridge channel: every
 * wired bridge, both directions, emits and listens here, discriminated
 * by the payload's `_tag`. One channel rather than per-tag `bridge:{tag}`
 * because Tauri only guarantees FIFO within one event name — see the
 * package README ("Why one channel and not per-tag"). Rust hosts pin the
 * same literal; `event-names.test.ts` is the drift guard.
 */
const BRIDGE_EVENT = 'bridge'

/**
 * Web→host readiness tag, emitted once every inbound listener is
 * attached; the host replies with its boot-time state. Same `__Ready`
 * literal as effect-messaging-core's handshake, kept as a tag so it
 * rides the one shared channel.
 */
const READY_TAG = '__Ready'

export { BRIDGE_EVENT, READY_TAG }
