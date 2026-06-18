//! Tauri host plumbing for the browser sniffer. See
//! [`slices/browser-sniffer/docs/Tauri Host Explanation.md`](../../../slices/browser-sniffer/docs/Tauri%20Host%20Explanation.md)
//! for the full architecture write-up; this module is the public surface
//! and event-bus glue.

mod bootstrap;
pub mod events;
mod handlers;
mod model;
mod sniffer_window;

use shared_structures_rust::bridge::{BridgeEnvelope, BRIDGE_EVENT};
use tauri::{AppHandle, Listener};
use tauri_plugin_log::log;

pub use crate::sniffer_window::SNIFFER_WEBVIEW_LABEL;

/// Wire one listener on the multiplexed bridge event and route the
/// three CollectorBridge.webToHost tags this crate cares about by the
/// envelope's `_tag`. Idempotent at the listener level — call once per
/// app lifecycle from `setup()`.
///
/// Decode failures inside each handler log at warn; tags this crate
/// does not care about (host→web emits echoing back, sibling slices'
/// web→host traffic) are dropped silently.
pub fn attach_browser_sniffer(app: &AppHandle) {
    // Cross-process tag-uniqueness aid: the bridge channel is shared
    // with every other listener (`wildflower-tauri::bridge`, the React
    // transport, the sniffer's web-side bootstrap). There is no
    // automated guard against a tag colliding across listeners, so log
    // this crate's known tag set at attach time. See
    // `global/effect-messaging/effect-messaging-tauri/README.md`
    // ("Tag uniqueness across processes — manual discipline") for the
    // procedure when adding a new tag.
    log::info!(
        "[browser-sniffer] listening on '{BRIDGE_EVENT}' for tags: [{}, {}, {}]",
        events::REQUEST_SNIFFABLE_WEBVIEW,
        events::OPEN,
        events::SNIFFING_COMPLETE,
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
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bootstrap::SNIFFER_BOOTSTRAP;

    /// Drift guard for this crate's sniffer-specific tag literals. The
    /// shared `BRIDGE_EVENT` is drift-guarded in
    /// `shared_structures_rust::bridge::tests`; this crate only owns
    /// the per-tag literals on the multiplexed channel.
    #[test]
    fn bridge_tags_match_the_ts_convention() {
        assert_eq!(events::REQUEST_SNIFFABLE_WEBVIEW, "RequestSniffableWebView");
        assert_eq!(events::OPEN, "Open");
        assert_eq!(events::SNIFFING_COMPLETE, "SniffingComplete");
    }

    /// The bootstrap IIFE is generated at build time. An empty file
    /// silently injects a no-op into the sniffer webview; surface it
    /// loudly here so a missing regeneration step (`vp run
    /// generate-tauri-bootstrap` in `browser-sniffer-tauri`, or the
    /// tauri CI job's pnpm install) fails the test suite before
    /// reaching runtime.
    #[test]
    fn bootstrap_is_non_empty() {
        assert!(
            SNIFFER_BOOTSTRAP.len() > 1000,
            "SNIFFER_BOOTSTRAP is {} bytes; expected >1000. The generated file at \
             slices/browser-sniffer/browser-sniffer-tauri/dist/tauri-bootstrap.js looks empty or \
             stale — run `vp install` or `vp run generate-tauri-bootstrap` in that package.",
            SNIFFER_BOOTSTRAP.len(),
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
