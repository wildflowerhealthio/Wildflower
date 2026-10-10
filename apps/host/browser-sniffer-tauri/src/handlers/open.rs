use tauri::AppHandle;
use tauri_plugin_log::log;

use crate::events::OPEN;
use crate::model::open::OpenPayload;
use crate::model::web_view_source::resolve_source;
use crate::sniffer_window::open_or_navigate;

/// Decode the payload, resolve its `WebViewSource`, and navigate the
/// sniffer webview to the new source. If the webview is missing — which is the
/// normal case for a plan's leading `Open`, the only thing that builds it —
/// fall through to opening a fresh one rather than dropping the event.
pub(crate) fn handle(app: &AppHandle, payload: &str) {
    let decoded = match serde_json::from_str::<OpenPayload>(payload) {
        Ok(decoded) => decoded,
        Err(error) => {
            log::warn!("[browser-sniffer] undecodable {OPEN} payload dropped: {error}");
            return;
        }
    };
    let url = match resolve_source(decoded.source) {
        Ok(url) => url,
        Err(error) => {
            log::warn!("[browser-sniffer] cannot resolve Open source: {error}");
            return;
        }
    };
    if let Err(error) = open_or_navigate(app, url) {
        log::error!("[browser-sniffer] failed to (re)navigate sniffer webview: {error}");
    }
}
