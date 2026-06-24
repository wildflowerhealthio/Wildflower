use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager};
use tauri_plugin_log::log;
use tauri_plugin_native_webview::NativeWebviewExt;

use crate::popup_bridge::PopupChannel;

/// Close the sniffer popup.
///
/// Unified across platforms now that the sniffer routes every open through
/// `tauri-plugin-native-webview`: mobile dismisses the native sheet/dialog,
/// desktop closes the multi-webview popup window. The plugin's `close` is
/// itself idempotent (`{closedByRequest: false}` when nothing is open), so
/// SPA-fired `SniffingComplete` without a live popup lands harmlessly.
pub(crate) fn handle(app: &AppHandle) {
    // This close is host-initiated by the SniffingComplete the host just
    // observed, so flag it: the resulting NativeWebviewEvent::Closed must not
    // re-emit a second SniffingComplete (see popup_bridge::dispatch_body).
    app.state::<PopupChannel>()
        .host_close_pending
        .store(true, Ordering::SeqCst);

    if let Err(error) = app.native_webview().close(false) {
        log::error!("[browser-sniffer] failed to dismiss native popup: {error}");
    }
}
