/**
 * Wire literals the sandboxed-webview bootstrap shares with its Rust host
 * (`shared-structures-tauri-rust`).
 *
 * Hardcoded rather than imported from `effect-messaging-*` because the bundled
 * IIFE can't pull in workspace modules (see the sniffer's `install-sniffer.ts`
 * for the same constraint). A drift guard in the bootstrap test pins
 * {@link BRIDGE_EVENT} against the canonical channel name, and the Rust crate's
 * `bridge_tags_match_the_ts_convention` test pins {@link CLOSE_SANDBOXED_WEBVIEW_TAG}.
 */

/** Multiplexed Tauri event channel every bridge tag rides on. */
const BRIDGE_EVENT = 'bridge'

/**
 * Web→host tag the sandboxed-webview top bar emits to ask the host to close the
 * window — when the user taps Close, or taps Back with no history left. Carries
 * an empty struct beyond the `_tag` discriminator; the host ignores the body.
 */
const CLOSE_SANDBOXED_WEBVIEW_TAG = 'CloseSandboxedWebView'

export { BRIDGE_EVENT, CLOSE_SANDBOXED_WEBVIEW_TAG }
