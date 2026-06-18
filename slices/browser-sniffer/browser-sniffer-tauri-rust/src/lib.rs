//! Tauri host plumbing for the browser sniffer. See
//! [`slices/browser-sniffer/docs/Tauri Host Explanation.md`](../../../slices/browser-sniffer/docs/Tauri%20Host%20Explanation.md)
//! for the full architecture write-up; this module is the public surface
//! and event-bus glue.

mod bootstrap;
pub mod events;
mod handlers;
mod model;
mod sniffer_window;

use tauri::{AppHandle, Listener};

pub use crate::sniffer_window::SNIFFER_WEBVIEW_LABEL;

/// Wire the three CollectorBridge.webToHost listeners onto Tauri's
/// event bus. Idempotent at the listener level — call once per app
/// lifecycle from `setup()`.
pub fn attach_browser_sniffer(app: &AppHandle) {
    {
        let handle = app.clone();
        app.listen(events::REQUEST_SNIFFABLE_WEBVIEW, move |event| {
            handlers::request_sniffable_webview::handle(&handle, event.payload());
        });
    }
    {
        let handle = app.clone();
        app.listen(events::OPEN, move |event| {
            handlers::open::handle(&handle, event.payload());
        });
    }
    {
        let handle = app.clone();
        app.listen(events::SNIFFING_COMPLETE, move |_event| {
            // SniffingComplete carries an empty struct on the wire; no
            // decode needed beyond the listener firing.
            handlers::sniffing_complete::handle(&handle);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bootstrap::SNIFFER_BOOTSTRAP;

    /// Drift guard: the TS side pins the same literals via
    /// `bridge:{tag}` where `tag` is the bridge schema's tag name.
    #[test]
    fn event_names_match_the_ts_convention() {
        assert_eq!(
            events::REQUEST_SNIFFABLE_WEBVIEW,
            "bridge:RequestSniffableWebView"
        );
        assert_eq!(events::OPEN, "bridge:Open");
        assert_eq!(events::SNIFFING_COMPLETE, "bridge:SniffingComplete");
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
