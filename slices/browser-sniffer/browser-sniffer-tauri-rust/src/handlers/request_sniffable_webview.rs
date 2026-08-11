use tauri::{AppHandle, WebviewUrl};
use tauri_plugin_log::log;

use crate::events::REQUEST_SNIFFABLE_WEBVIEW;
use crate::model::request_sniffable_webview::RequestSniffableWebViewPayload;
use crate::sniffer_window::open_or_navigate;

/// Validate the payload shape (it carries no starting page) and mount the
/// sniffer webview on `about:blank`. The plan drives the first real navigation
/// with a leading `Open` step; `about:blank` settles almost immediately, giving
/// the automatic-navigation machine the first `PageLoaded` it drains on. Decode
/// failures and Tauri build failures log at warn/error — the listener loop
/// continues to the next event.
pub(crate) fn handle(app: &AppHandle, payload: &str) {
    if let Err(error) = serde_json::from_str::<RequestSniffableWebViewPayload>(payload) {
        log::warn!(
            "[browser-sniffer] undecodable {REQUEST_SNIFFABLE_WEBVIEW} payload dropped: {error}"
        );
        return;
    }
    // `url::Url::parse("about:blank")` is infallible in practice; guard it
    // rather than `unwrap` so the listener loop survives any surprise.
    let url = match url::Url::parse("about:blank") {
        Ok(parsed) => WebviewUrl::External(parsed),
        Err(error) => {
            log::error!("[browser-sniffer] failed to parse about:blank url: {error}");
            return;
        }
    };
    if let Err(error) = open_or_navigate(app, url) {
        log::error!("[browser-sniffer] failed to open sniffer webview: {error}");
    }
}
