use tauri::AppHandle;
use tauri_plugin_log::log;
use tauri_plugin_native_webview::NativeWebviewExt;

/// Close the sniffer popup.
///
/// Unified across platforms now that the sniffer routes every open through
/// `tauri-plugin-native-webview`: mobile dismisses the native sheet/dialog,
/// desktop closes the multi-webview popup window. The plugin's `close` is
/// itself idempotent (`{closedByRequest: false}` when nothing is open), so
/// SPA-fired `SniffingComplete` without a live popup lands harmlessly.
pub(crate) fn handle(app: &AppHandle) {
    // This close is host-initiated by the `SniffingComplete` the host just
    // observed and re-emitted on the bridge, so pass `suppress_close_event =
    // true`: the plugin then skips the `NativeWebviewEvent::Closed` echo this
    // dismissal produces, which `popup_bridge` would otherwise turn into a
    // *second* `SniffingComplete`. A user / OS dismissal goes through the plugin
    // without suppression and still emits. This keeps the "who closed it"
    // knowledge in the close protocol rather than a cross-module flag.
    if let Err(error) = app.native_webview().close(true) {
        log::error!("[browser-sniffer] failed to dismiss native popup: {error}");
    }
}
