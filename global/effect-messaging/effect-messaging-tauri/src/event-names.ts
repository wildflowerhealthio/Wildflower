/**
 * Tauri event-name convention for bridge messages: `bridge:{tag}`.
 *
 * @remarks
 * Each bridge message travels on its own Tauri event, named after its
 * `_tag` — no multiplexed channel, no string envelope. The Rust host
 * must listen/emit with the same literals; both sides pin them with a
 * test (TS: `event-names.test.ts`; Rust: the host crate's bridge
 * module) so drift breaks a build instead of a runtime handshake.
 * Tags only contain characters Tauri accepts in event names
 * (alphanumeric plus `-`, `/`, `:`, `_`).
 */
const eventNameForTag = <const Tag extends string>(tag: Tag): `bridge:${Tag}` => `bridge:${tag}`

/**
 * Web→host readiness tag. The web side emits it once every inbound
 * listener is attached; the host replies with its boot-time state
 * (e.g. the gatekeeper's `AuthTokenIssued`). Same `__Ready` literal as
 * effect-messaging-core's transport handshake.
 */
const READY_TAG = '__Ready'

/** The readiness signal's full Tauri event name. */
const READY_EVENT = eventNameForTag(READY_TAG)

export { eventNameForTag, READY_EVENT, READY_TAG }
