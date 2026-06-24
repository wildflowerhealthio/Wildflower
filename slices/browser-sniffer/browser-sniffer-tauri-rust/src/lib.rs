//! Tauri host plumbing for the browser sniffer. See
//! [`slices/browser-sniffer/docs/Tauri Host Explanation.md`](../../../slices/browser-sniffer/docs/Tauri%20Host%20Explanation.md)
//! for the full architecture write-up; this module is the public surface
//! and event-bus glue.

mod bootstrap;
pub mod events;
mod handlers;
mod model;
mod native_webview_bridge;
mod sniffer_window;

use shared_structures_rust::bridge::{BridgeEnvelope, BRIDGE_EVENT};
use tauri::{AppHandle, Listener};
use tauri_plugin_log::log;

/// Wire one listener on the multiplexed bridge event and route the
/// CollectorBridge tags this crate cares about by the envelope's `_tag`.
/// Idempotent at the listener level — call once per app lifecycle from
/// `setup()`.
///
/// This also wires the native-webview bridge on every platform now that the
/// sniffer routes through `tauri-plugin-native-webview` everywhere: a long-lived
/// `Channel<NativeWebviewEvent>` whose handler re-emits the native webview's
/// `Message` events onto `BRIDGE_EVENT` and logs its `Hidden` / `Disposed`
/// lifecycle events (neither is terminal — the SPA owns `SniffingComplete`).
/// Only the inbound `Click` / `CancelSnifferRequest` forwarding into the native
/// webview via `evaluate_js` stays mobile-only — on desktop the content webview
/// is a Tauri webview that receives `app.emit('bridge', …)` natively, so those
/// forwarders are `cfg`-gated out.
///
/// Decode failures inside each handler log at warn; tags this crate
/// does not care about (sibling slices' bridge traffic) are dropped silently.
pub fn attach_browser_sniffer(app: &AppHandle) {
    native_webview_bridge::install(app);
    // The bridge channel is shared across listeners with no automated
    // cross-process tag guard; log this crate's tag set at attach time so
    // the boot log shows who dispatches what. See the effect-messaging-tauri
    // README ("Tag uniqueness across processes").
    log::info!(
        "[browser-sniffer] listening on '{BRIDGE_EVENT}' for tags: [{}, {}, {}, {}, {}]",
        events::REQUEST_SNIFFABLE_WEBVIEW,
        events::OPEN,
        events::SNIFFING_COMPLETE,
        events::CLICK,
        events::CANCEL_SNIFFER_REQUEST,
    );
    let handle = app.clone();
    app.listen(BRIDGE_EVENT, move |event| {
        let payload = event.payload();
        let tag = match serde_json::from_str::<BridgeEnvelope>(payload) {
            Ok(envelope) => envelope.tag,
            Err(error) => {
                log::warn!("[browser-sniffer] undecodable bridge payload dropped: {error}");
                return;
            }
        };
        match tag.as_str() {
            events::REQUEST_SNIFFABLE_WEBVIEW => {
                handlers::request_sniffable_webview::handle(&handle, payload);
            }
            events::OPEN => handlers::open::handle(&handle, payload),
            events::SNIFFING_COMPLETE => handlers::sniffing_complete::handle(&handle),
            #[cfg(any(target_os = "ios", target_os = "android"))]
            events::CLICK | events::CANCEL_SNIFFER_REQUEST => {
                native_webview_bridge::forward_to_native_webview(&handle, payload);
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drift guard for this crate's sniffer-specific tag literals. The
    /// shared `BRIDGE_EVENT` is drift-guarded in
    /// `shared_structures_rust::bridge::tests`; this crate only owns
    /// the per-tag literals on the multiplexed channel.
    #[test]
    fn bridge_tags_match_the_ts_convention() {
        assert_eq!(events::REQUEST_SNIFFABLE_WEBVIEW, "RequestSniffableWebView");
        assert_eq!(events::OPEN, "Open");
        assert_eq!(events::SNIFFING_COMPLETE, "SniffingComplete");
        assert_eq!(events::CLICK, "Click");
        assert_eq!(events::CANCEL_SNIFFER_REQUEST, "CancelSnifferRequest");
    }

    /// The bootstrap IIFE is generated at build time. An empty file
    /// silently injects a no-op into the sniffer webview; surface it
    /// loudly here so a missing regeneration step (`vp run
    /// generate-tauri-bootstrap` / `generate-native-bootstrap` in
    /// `browser-sniffer-tauri`, or the tauri CI job's pnpm install)
    /// fails the test suite before reaching runtime.
    ///
    /// Per-target: desktop checks `SNIFFER_BOOTSTRAP` (the `WebviewWindow`
    /// path); mobile checks `NATIVE_SNIFFER_BOOTSTRAP` (the
    /// `tauri-plugin-native-webview` path). The off-target constant is
    /// `cfg`-gated out of `bootstrap.rs`, so referencing both here
    /// unconditionally would fail to compile on the other target.
    #[test]
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    fn bootstrap_is_non_empty() {
        use crate::bootstrap::SNIFFER_BOOTSTRAP;
        assert!(
            SNIFFER_BOOTSTRAP.len() > 1000,
            "SNIFFER_BOOTSTRAP is {} bytes; expected >1000. The generated file at \
             slices/browser-sniffer/browser-sniffer-tauri/dist/tauri-bootstrap.js looks empty or \
             stale — run `vp install` or `vp run generate-tauri-bootstrap` in that package.",
            SNIFFER_BOOTSTRAP.len(),
        );
    }

    #[test]
    #[cfg(any(target_os = "ios", target_os = "android"))]
    fn native_bootstrap_is_non_empty() {
        use crate::bootstrap::NATIVE_SNIFFER_BOOTSTRAP;
        assert!(
            NATIVE_SNIFFER_BOOTSTRAP.len() > 1000,
            "NATIVE_SNIFFER_BOOTSTRAP is {} bytes; expected >1000. The generated file at \
             slices/browser-sniffer/browser-sniffer-tauri/dist/native-bootstrap.js looks empty or \
             stale — run `vp install` or `vp run generate-native-bootstrap` in that package.",
            NATIVE_SNIFFER_BOOTSTRAP.len(),
        );
    }

    #[test]
    fn window_labels_match_tauri_conf() {
        // tauri.conf.json's window default label is "main" when none is
        // set in `app.windows[].label`. The existing bridge.rs pins the
        // same literal — drift here would also break the consent popup
        // raise path.
        assert_eq!(events::MAIN_WINDOW_LABEL, "main");
    }
}
