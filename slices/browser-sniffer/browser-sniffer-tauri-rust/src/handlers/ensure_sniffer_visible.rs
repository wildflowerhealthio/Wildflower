use tauri::AppHandle;
use tauri_plugin_log::log;
use tauri_plugin_native_webview::NativeWebviewExt;

/// (Re-)present the sniffer's native webview — the SPA's `EnsureWindowVisible`
/// step asking that the window be on screen (e.g. before an `AwaitUserDismiss`
/// hold, after the user dismissed it earlier in the run).
///
/// Maps to the plugin's `show`, which is **non-destructive**: it re-presents a
/// hidden-but-alive webview *without* re-navigating (contrast `open`, which
/// reloads the page), and is idempotent — a `show` with no live native webview
/// lands harmlessly. Payload-less, so there is nothing to decode.
pub(crate) fn handle(app: &AppHandle) {
    if let Err(error) = app.native_webview().show(crate::SNIFFER_WEBVIEW_ID) {
        log::error!("[browser-sniffer] failed to show the sniffer webview: {error}");
    }
}
