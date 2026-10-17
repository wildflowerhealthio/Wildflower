//! Tauri host plumbing for the browser sniffer. See
//! [`slices/browser-sniffer/docs/Tauri Host Explanation.md`](../../../../slices/browser-sniffer/docs/Tauri%20Host%20Explanation.md)
//! for the full architecture write-up; this module is the public surface
//! and event-bus glue.

mod bootstrap;
pub mod events;
mod handlers;
mod model;
mod native_webview_bridge;
mod sniffer_window;

/// The `tauri-plugin-native-webview` instance id this slice owns. The sniffer's
/// scrape webview is a distinct instance from the apps-launch popup (`"launch"`),
/// so a background scrape and a launched app can coexist without one navigating
/// the other's webview away. Every `native_webview()` call in this crate keys on
/// it.
pub(crate) const SNIFFER_WEBVIEW_ID: &str = "sniffer";

use tauri::{AppHandle, Listener};
use tauri_plugin_log::log;
use wildflowerhealthio_shared_structures::bridge::{BridgeEnvelope, BRIDGE_EVENT};

/// The desktop content webview's gated web→host data-plane command. The app's
/// `invoke_handler` registers it; `capabilities/native-webview-window.json`
/// grants it only to the untrusted content webview in lieu of a bus `emit`
/// grant. See [`native_webview_bridge::native_webview_data_plane_emit`].
pub use native_webview_bridge::native_webview_data_plane_emit;

/// Wire one listener on the multiplexed bridge event and route the sniffer
/// control tags this crate cares about by the envelope's `_tag`.
/// Idempotent at the listener level — call once per app lifecycle from
/// `setup()`.
///
/// This also wires the native-webview bridge (`native_webview_bridge::install`)
/// on every platform. The inbound `PageAction` / `CancelSnifferRequest`
/// forwarding into the native webview stays mobile-only — on desktop the
/// content webview is a Tauri webview that receives `app.emit('bridge', …)`
/// natively, so those forwarders are `cfg`-gated out.
///
/// Decode failures inside each handler log at warn; tags this crate
/// does not care about (sibling slices' bridge traffic) are dropped silently.
pub fn attach_browser_sniffer(app: &AppHandle) {
    native_webview_bridge::install(app);
    // The bridge channel is shared across listeners with no automated
    // cross-process tag guard; log this crate's tag set at attach time so
    // the boot log shows who dispatches what. See the effect-messaging-tauri-js
    // README ("Tag uniqueness across processes").
    log::info!(
        "[browser-sniffer] listening on '{BRIDGE_EVENT}' for tags: [{}, {}, {}, {}]",
        events::OPEN,
        events::SNIFFING_COMPLETE,
        events::PAGE_ACTION,
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
            events::OPEN => handlers::open::handle(&handle, payload),
            events::SNIFFING_COMPLETE => handlers::sniffing_complete::handle(&handle),
            #[cfg(any(target_os = "ios", target_os = "android"))]
            events::PAGE_ACTION | events::CANCEL_SNIFFER_REQUEST => {
                native_webview_bridge::forward_to_native_webview(&handle, payload);
            }
            _ => {}
        }
    });
}

/// `apps/host/recorder/recorder-wire-golden.json`, the `RecorderBridge`
/// payloads the TS side (`recorder-core-js`'s `bridge.test.ts`) and
/// `recorder-rust` read too. This crate's tests check the messages it routes
/// and emits against it.
#[cfg(test)]
pub(crate) fn recorder_wire_golden() -> serde_json::Value {
    serde_json::from_str(include_str!("../../recorder/recorder-wire-golden.json"))
        .expect("recorder-wire-golden.json is JSON")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drift guard for this crate's sniffer-specific tag literals. The
    /// shared `BRIDGE_EVENT` is drift-guarded in
    /// `wildflowerhealthio_shared_structures::bridge::tests`; this crate only owns
    /// the per-tag literals on the multiplexed channel. The golden tests check
    /// the tags `recorder-wire-golden.json` carries; this one also covers
    /// `PageAction` and `CancelSnifferRequest`, which it does not.
    #[test]
    fn bridge_tags_match_the_ts_convention() {
        assert_eq!(events::OPEN, "Open");
        assert_eq!(events::SNIFFING_COMPLETE, "SniffingComplete");
        assert_eq!(events::PAGE_ACTION, "PageAction");
        assert_eq!(events::CANCEL_SNIFFER_REQUEST, "CancelSnifferRequest");
        assert_eq!(events::USER_DISMISSED, "UserDismissed");
        assert_eq!(events::SNIFFER_DISPOSED, "SnifferDisposed");
        assert_eq!(events::PAGE_REQUESTED, "PageRequested");
    }

    /// What the Recorder sends for `Open` decodes here, and its source
    /// resolves to a webview URL.
    #[test]
    fn open_matches_the_golden_file() {
        let golden = recorder_wire_golden();
        let open: model::open::OpenPayload =
            serde_json::from_value(golden["webToHost"][events::OPEN].clone())
                .expect("golden Open decodes");
        model::web_view_source::resolve_source(open.source).expect("golden Open source resolves");
    }

    /// The listener routes `Open` and `SniffingComplete` by `_tag`, so both
    /// must be golden web→host tags whose payload carries that tag.
    #[test]
    fn routed_tags_match_the_golden_file() {
        let golden = recorder_wire_golden();
        for tag in [events::OPEN, events::SNIFFING_COMPLETE] {
            let payload = golden["webToHost"]
                .get(tag)
                .unwrap_or_else(|| panic!("`{tag}` has no golden webToHost payload"));
            assert_eq!(payload["_tag"], tag);
        }
    }

    /// The bootstrap IIFE is generated at build time. An empty file
    /// silently injects a no-op into the sniffer webview; surface it
    /// loudly here so a missing regeneration step (`vp run
    /// generate-tauri-bootstrap` / `generate-native-bootstrap` in
    /// `browser-sniffer-tauri-js`, or the tauri CI job's pnpm install)
    /// fails the test suite before reaching runtime.
    ///
    /// Split per-target because the off-target constant is `cfg`-gated out of
    /// `bootstrap.rs`: desktop checks `SNIFFER_BOOTSTRAP`, mobile checks
    /// `NATIVE_SNIFFER_BOOTSTRAP`.
    #[test]
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    fn bootstrap_is_non_empty() {
        use crate::bootstrap::SNIFFER_BOOTSTRAP;
        assert!(
            SNIFFER_BOOTSTRAP.len() > 1000,
            "SNIFFER_BOOTSTRAP is {} bytes; expected >1000. The generated file at \
             slices/browser-sniffer/browser-sniffer-tauri-js/dist/tauri-bootstrap.js looks empty or \
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
             slices/browser-sniffer/browser-sniffer-tauri-js/dist/native-bootstrap.js looks empty or \
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
