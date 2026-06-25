use tauri::AppHandle;
use tauri_plugin_log::log;
use tauri_plugin_native_webview::NativeWebviewExt;

/// Dispose the sniffer's native webview — the sniff is done, so free its
/// resources.
///
/// `SniffingComplete` is the SPA's terminal signal: the collector has finished,
/// so the native webview (its background runtime) should be torn down rather
/// than merely hidden. Unified across platforms via `tauri-plugin-native-webview`:
/// mobile tears down the native sheet/dialog, desktop destroys the multi-webview
/// window. `dispose` is idempotent (`{requestCausedDispose: false}` when nothing exists), so
/// an `SniffingComplete` with no live native webview lands harmlessly.
///
/// A *user* dismissal is different — it `hide`s the native webview (keeping it
/// alive and sniffing in the background) and never reaches here; only the SPA's
/// `SniffingComplete` disposes.
pub(crate) fn handle(app: &AppHandle) {
    if let Err(error) = app.native_webview().dispose() {
        log::error!("[browser-sniffer] failed to dispose the native webview: {error}");
    }
}
