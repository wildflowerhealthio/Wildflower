//! Tauri host adapter for the browser sniffer. See
//! [`slices/browser-sniffer/docs/Tauri Host Explanation.md`](../../../slices/browser-sniffer/docs/Tauri%20Host%20Explanation.md)
//! for the full architecture write-up.
//!
//! `browser-sniffer-rust` owns the `/sniffer` HTTP surface (the control
//! endpoints + the events WebSocket); this crate is the host half behind its
//! two ports:
//!
//!  - [`TauriSnifferWebviewHandle`] implements the `SnifferWebviewHandle`
//!    port over `tauri-plugin-native-webview` (open/navigate, status
//!    subtitle, show, dispose, and the `evaluate_js` forward into the page).
//!  - [`attach_browser_sniffer`] wires the page→host side: the plugin's
//!    native-webview channel and the desktop data-plane command validate
//!    untrusted page messages (allowlist + duplicate-key rejection) and
//!    publish them — plus the synthesized `UserDismissed` / `SnifferDisposed`
//!    lifecycle events — into the `SnifferEvents` stream the HTTP crate fans
//!    out.

mod bootstrap;
mod native_webview_bridge;
mod sniffer_window;
mod webview_handle;

/// The `tauri-plugin-native-webview` instance id this slice owns. The sniffer's
/// scrape webview is a distinct instance from the apps-launch popup (`"launch"`),
/// so a background scrape and a launched app can coexist without one navigating
/// the other's webview away. Every `native_webview()` call in this crate keys on
/// it.
pub(crate) const SNIFFER_WEBVIEW_ID: &str = "sniffer";

use browser_sniffer_rust::SnifferEvents;
use tauri::AppHandle;

/// The desktop content webview's gated web→host data-plane command. The app's
/// `invoke_handler` registers it; `capabilities/native-webview-window.json`
/// grants it only to the untrusted content webview.
/// See [`native_webview_bridge::native_webview_data_plane_emit`].
pub use native_webview_bridge::native_webview_data_plane_emit;
pub use webview_handle::TauriSnifferWebviewHandle;

/// Wire the page→host side of the sniffer: install the plugin's
/// native-webview channel and stash `events` where the desktop data-plane
/// command can reach it. Validated page messages and synthesized lifecycle
/// events are published into `events`. Idempotent at the install level — call
/// once per app lifecycle from `setup()`, with a clone of the same
/// `SnifferEvents` handed to `browser_sniffer_rust::setup_browser_sniffer`.
pub fn attach_browser_sniffer(app: &AppHandle, events: SnifferEvents) {
    native_webview_bridge::install(app, events);
}

#[cfg(test)]
mod tests {
    /// The bootstrap IIFE is generated at build time. An empty file
    /// silently injects a no-op into the sniffer webview; surface it
    /// loudly here so a missing regeneration step (`vp run
    /// generate-tauri-bootstrap` / `generate-native-bootstrap` in
    /// `browser-sniffer-tauri`, or the tauri CI job's pnpm install)
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
}
