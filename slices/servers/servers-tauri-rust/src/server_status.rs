//! The [`SERVER_STATUS_EVENT`]: each server's status on `TauriUnitRunner`,
//! sent to the base whenever it changes.

use servers_rust::{ServerDetail, ServerStatus, ServerStatusTracker};
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_log::log;
use tauri_unit_runner::UnitStatuses;
use tokio::sync::watch;

use crate::BASE_WEBVIEW_LABEL;

/// The Tauri event a server's [`ServerStatus`] is emitted on, one event per
/// server whose status changed, to the `main` webview, which runs the base.
///
/// A removed server gets no event: the base drops a server it no longer
/// lists, and `server_remove` answers once the server is gone.
pub const SERVER_STATUS_EVENT: &str = "server-status";

/// Emit the [`SERVER_STATUS_EVENT`] for each server whose status changed,
/// every time `TauriUnitRunner`'s statuses change, as [`ServerStatusTracker`]
/// picks them. The first statuses read are all emitted.
pub(crate) async fn emit_server_statuses<R: Runtime>(
    app: AppHandle<R>,
    mut statuses: watch::Receiver<UnitStatuses<ServerDetail>>,
) {
    let mut tracker = ServerStatusTracker::new();
    loop {
        let current = statuses.borrow_and_update().clone();
        for status in tracker.changed_statuses(&current) {
            emit_server_status(&app, &status);
        }
        if statuses.changed().await.is_err() {
            log::error!(
                "[servers] the unit runner's statuses closed; server-status events stopped"
            );
            return;
        }
    }
}

/// Emit `status` to the base. A failure is logged: the base reads every
/// status again from `servers_list`.
fn emit_server_status<R: Runtime>(app: &AppHandle<R>, status: &ServerStatus) {
    if let Err(error) = app.emit_to(BASE_WEBVIEW_LABEL, SERVER_STATUS_EVENT, status) {
        log::warn!(
            "[servers] the status of {} wasn't emitted: {error}",
            status.domain
        );
    }
}
