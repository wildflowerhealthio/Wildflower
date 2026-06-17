use tauri::{AppHandle, Manager};
use tauri_plugin_log::log;

use crate::events::SNIFFING_COMPLETE_EVENT;
use crate::sniffer_window::{mark_closed, SNIFFER_WEBVIEW_LABEL};

/// Close the sniffer webview. Flip the open/close sentinel *before*
/// asking Tauri to close, so a follow-up `RequestSniffableWebView`
/// arriving during the close tick always lands on the fresh-open path
/// (see `sniffer_window::open_or_navigate` for the race rationale).
pub(crate) fn handle(app: &AppHandle) {
    let was_open = mark_closed();
    let Some(webview_window) = app.get_webview_window(SNIFFER_WEBVIEW_LABEL) else {
        if was_open {
            log::debug!(
                "[browser-sniffer] {SNIFFING_COMPLETE_EVENT}: sentinel was open but no \
                 '{SNIFFER_WEBVIEW_LABEL}' webview found — already closed by another path"
            );
        } else {
            // SPA emitted SniffingComplete without an open sniffer
            // webview — legal at the bridge level (e.g. SPA decided
            // "done" before RequestSniffableWebView fired).
            log::debug!(
                "[browser-sniffer] {SNIFFING_COMPLETE_EVENT} received with no sniffer webview \
                 open; ignoring"
            );
        }
        return;
    };
    if let Err(error) = webview_window.close() {
        log::error!("[browser-sniffer] failed to close sniffer webview: {error}");
    }
}
