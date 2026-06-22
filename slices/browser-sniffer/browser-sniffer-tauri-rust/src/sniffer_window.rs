use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, WebviewUrl};

#[cfg(any(target_os = "ios", target_os = "android"))]
use crate::bootstrap::NATIVE_SNIFFER_BOOTSTRAP;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use crate::bootstrap::SNIFFER_BOOTSTRAP;

/// Label assigned to the legacy sniffer webview on desktop, before the
/// plugin path took over. Kept exported for the existing
/// `capabilities/browser-sniffer.json` capability that still mentions it
/// (now a dead grant — the active capability is
/// `native-webview-window.json`, which scopes the plugin's
/// `native-webview-content` webview). Safe to drop with the capability
/// JSON in a follow-up cleanup.
pub const SNIFFER_WEBVIEW_LABEL: &str = "browser-sniffer";

/// Sentinel for whether *we* believe the sniffer popup is open. Vestigial
/// since the plugin owns popup state on every platform now — the plugin's
/// `open` dedupes by inspecting its own current-webview state, and
/// `mark_closed` is called from the `SniffingComplete` handler without
/// gating anything off the result. Kept so the `mark_closed` /
/// `mark_closed_returns_previous_state_and_is_idempotent` test surface
/// stays callable; will be deleted with the legacy WebviewWindow path.
static SNIFFER_OPEN: AtomicBool = AtomicBool::new(false);

/// Mark the sniffer slot free. Returns the previous open/closed state.
pub(crate) fn mark_closed() -> bool {
    SNIFFER_OPEN.swap(false, Ordering::SeqCst)
}

/// Present the sniffer popup via `tauri-plugin-native-webview` on every
/// target. The plugin owns popup chrome (native toolbar on iOS / Android,
/// a multi-webview chrome bar on desktop), so the same call site works
/// across platforms — only the document-start `installSniffer` bootstrap
/// differs: mobile content webviews use the native-bridge variant
/// (`webkit.messageHandlers.nativeWebview` / `window.nativeWebview`),
/// desktop content webviews use the Tauri event-bus variant
/// (`__TAURI__.event`).
///
/// The plugin's `open` is idempotent: a second call while a popup is up
/// navigates the existing content webview to `url` rather than stacking a
/// new presentation. Initial title is the URL host (set by the plugin
/// itself); the sniffer overlays `subtitle: "Collecting Automatically"`
/// via `set_chrome` after open.
pub(crate) fn open_or_navigate(app: &AppHandle, url: WebviewUrl) -> anyhow::Result<()> {
    use tauri_plugin_native_webview::{NativeWebviewExt, OpenRequest, SetChromeRequest};

    use crate::popup_bridge::PopupChannel;

    let WebviewUrl::External(parsed) = url else {
        anyhow::bail!(
            "non-External WebviewUrl handed to native popup path — only Uri sources are \
             supported today"
        )
    };

    // The popup-side `installSniffer` IIFE — content-only, no in-page top
    // bar. Both the desktop (Tauri) and mobile (native bridges) variants
    // gate themselves on the appropriate transport and run the same
    // sniffer body underneath.
    #[cfg(any(target_os = "ios", target_os = "android"))]
    let bootstrap = NATIVE_SNIFFER_BOOTSTRAP;
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    let bootstrap = SNIFFER_BOOTSTRAP;

    // `Channel` clones share the same identifier and handler under an `Arc`,
    // so reusing the long-lived channel across opens routes every popup's
    // events to the same `popup_bridge` handler. A fresh open also clears any
    // stale host-close flag (e.g. a SniffingComplete that fired while no popup
    // was open) so a later user-initiated close still emits its terminal
    // SniffingComplete.
    let channel = {
        let popup = app.state::<PopupChannel>();
        popup.host_close_pending.store(false, Ordering::SeqCst);
        popup.channel.clone()
    };
    app.native_webview()
        .open(OpenRequest {
            url: parsed.to_string(),
            init_script: Some(bootstrap.to_owned()),
            channel,
        })
        .map_err(|error| anyhow::anyhow!("tauri-plugin-native-webview open failed: {error}"))?;

    // Push the sniffer's static status into the popup chrome's subtitle slot.
    // Title is left at the plugin's default (the URL host); message is empty
    // until a future step counts resources (e.g. "34 resources collected").
    // Done after open so the popup exists to render against.
    if let Err(error) = app.native_webview().set_chrome(SetChromeRequest {
        title: None,
        subtitle: Some("Collecting Automatically".to_owned()),
        message: None,
    }) {
        tauri_plugin_log::log::warn!(
            "[browser-sniffer] set_chrome failed after popup open: {error}"
        );
    }

    SNIFFER_OPEN.store(true, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_is_browser_sniffer() {
        // Internal label; integration tests in the wildflower-tauri layer
        // (and the legacy capability JSON's `webviews` array) rely on it.
        // The active runtime label is now `native-webview-content` from
        // the plugin; this constant survives only for the legacy capability
        // grant until that file is removed.
        assert_eq!(SNIFFER_WEBVIEW_LABEL, "browser-sniffer");
    }

    #[test]
    fn mark_closed_returns_previous_state_and_is_idempotent() {
        // This test mutates the global sentinel; it relies on serial
        // execution by cargo test's default single-threaded ordering per
        // module. The assertion is structured to be order-independent:
        // we set known state, observe, then restore.
        let prior = SNIFFER_OPEN.swap(true, Ordering::SeqCst);
        assert!(mark_closed(), "mark_closed should report previous-open");
        assert!(!mark_closed(), "second mark_closed is a no-op");
        SNIFFER_OPEN.store(prior, Ordering::SeqCst);
    }
}
