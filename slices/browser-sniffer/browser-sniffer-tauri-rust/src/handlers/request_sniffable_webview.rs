use tauri::AppHandle;
use tauri_plugin_log::log;

use crate::events::REQUEST_SNIFFABLE_WEBVIEW;
use crate::model::request_sniffable_webview::RequestSniffableWebViewPayload;
use crate::model::web_view_source::resolve_source;
use crate::sniffer_window::open_or_navigate;

/// Decode the payload, resolve its `WebViewSource`, and open or navigate
/// the sniffer webview. Decode failures and Tauri build failures log at
/// warn/error — the listener loop continues to the next event.
pub(crate) fn handle(app: &AppHandle, payload: &str) {
    let decoded = match serde_json::from_str::<RequestSniffableWebViewPayload>(payload) {
        Ok(decoded) => decoded,
        Err(error) => {
            log::warn!(
                "[browser-sniffer] undecodable {REQUEST_SNIFFABLE_WEBVIEW} payload \
                 dropped: {error}"
            );
            return;
        }
    };
    let url = match resolve_source(decoded.source) {
        Ok(url) => url,
        Err(error) => {
            log::warn!("[browser-sniffer] cannot resolve RequestSniffableWebView source: {error}");
            return;
        }
    };
    if let Err(error) = open_or_navigate(app, url) {
        log::error!("[browser-sniffer] failed to open sniffer webview: {error}");
    }
}
