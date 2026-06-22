use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager};
use tauri_plugin_log::log;
use tauri_plugin_native_webview::NativeWebviewExt;

use crate::popup_bridge::PopupChannel;
use crate::sniffer_window::mark_closed;

/// Close the sniffer popup. Flips the open/closed sentinel before asking
/// the plugin to dismiss so a follow-up `RequestSniffableWebView` arriving
/// during the close tick lands on a fresh popup (see
/// `sniffer_window::open_or_navigate` for the race rationale).
///
/// Unified across platforms now that the sniffer routes every open through
/// `tauri-plugin-native-webview`: mobile dismisses the native sheet/dialog,
/// desktop closes the multi-webview popup window. The plugin's `close` is
/// itself idempotent (`{closed: false}` when nothing is open), so SPA-fired
/// `SniffingComplete` without a live popup lands harmlessly.
pub(crate) fn handle(app: &AppHandle) {
    // Sentinel update — vestigial post-migration but kept callable for the
    // `mark_closed_returns_previous_state_and_is_idempotent` test surface.
    let _ = mark_closed();

    // This close is host-initiated by the SniffingComplete the host just
    // observed, so flag it: the resulting PopupEvent::Closed must not re-emit a
    // second SniffingComplete (see popup_bridge::dispatch_body).
    app.state::<PopupChannel>()
        .host_close_pending
        .store(true, Ordering::SeqCst);

    if let Err(error) = app.native_webview().close() {
        log::error!("[browser-sniffer] failed to dismiss native popup: {error}");
    }
}
