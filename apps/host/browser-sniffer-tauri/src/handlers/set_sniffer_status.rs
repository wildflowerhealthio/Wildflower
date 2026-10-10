use tauri::AppHandle;
use tauri_plugin_log::log;

use crate::events::SET_SNIFFER_STATUS;
use crate::model::set_sniffer_status::SetSnifferStatusPayload;
use crate::sniffer_window::set_status;

/// Decode the payload and write its `name` to the sniffer chrome subtitle. A
/// decode failure or a missing native webview is warned-and-dropped — a chrome
/// label is best-effort and must never interrupt the run.
pub(crate) fn handle(app: &AppHandle, payload: &str) {
    let decoded = match serde_json::from_str::<SetSnifferStatusPayload>(payload) {
        Ok(decoded) => decoded,
        Err(error) => {
            log::warn!(
                "[browser-sniffer] undecodable {SET_SNIFFER_STATUS} payload dropped: {error}"
            );
            return;
        }
    };
    if let Err(error) = set_status(app, decoded.name) {
        log::warn!("[browser-sniffer] failed to set sniffer chrome subtitle: {error}");
    }
}
