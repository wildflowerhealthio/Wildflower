//! The [`SERVER_STATUS_EVENT`]: each server's status on `TauriUnitRunner`,
//! with its certificate's state, sent to the base whenever it changes; and
//! [`certificate_state`], the certificate state a status carries, which
//! `servers_list` reads too.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures_util::future::join_all;
use servers_rust::{ServerDetail, ServerRecord, ServerRegistry, ServerStatus, ServerStatusTracker};
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_log::log;
use tauri_unit_runner_rust::{UnitStatus, UnitStatuses};
use tokio::sync::watch;
use wildflower_server_rust::CertificateState;

use crate::BASE_WEBVIEW_LABEL;

/// The Tauri event a server's [`ServerStatus`] is emitted on, one event per
/// server whose status changed, to the `main` webview, which runs the base.
///
/// A removed server gets no event: the base drops a server it no longer
/// lists, and `server_remove` answers once the server is gone.
pub const SERVER_STATUS_EVENT: &str = "server-status";

/// The certificate state of the server `record` describes, whose status is
/// `unit_status`: the one its run reported
/// ([`ServerStatus::run_certificate`]), or, without one, what the server's
/// certificate cache in `data_root` says, read now.
pub(crate) async fn certificate_state(
    data_root: &Path,
    record: &ServerRecord,
    unit_status: &UnitStatus<ServerDetail>,
) -> CertificateState {
    match ServerStatus::run_certificate(unit_status) {
        Some(certificate) => certificate.clone(),
        None => {
            wildflower_server_rust::cached_certificate_state(
                &record.domain(),
                &record.device_certificate_config(data_root),
            )
            .await
        }
    }
}

/// Emit the [`SERVER_STATUS_EVENT`] for each server whose status changed,
/// every time `TauriUnitRunner`'s statuses change, as [`ServerStatusTracker`]
/// picks them, each with its certificate state: its run's, or what its cache
/// in `data_root` says, for a server `registry` holds. The first statuses
/// read are all emitted.
pub(crate) async fn emit_server_statuses<R: Runtime>(
    app: AppHandle<R>,
    mut statuses: watch::Receiver<UnitStatuses<ServerDetail>>,
    registry: Arc<dyn ServerRegistry>,
    data_root: PathBuf,
) {
    let mut tracker = ServerStatusTracker::new();
    loop {
        let current = statuses.borrow_and_update().clone();
        let changed = tracker.changed_statuses(&current);
        for status in with_certificates(&registry, &data_root, changed).await {
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

/// Each of the `changed` statuses with its server's certificate state (see
/// [`certificate_state`]). `registry` is read for the servers' records only
/// when a status has no run's certificate state, and their caches are read
/// concurrently. A status whose server `registry` doesn't hold, or can't be
/// read for, is logged and left out: the base reads every status again from
/// `servers_list`.
pub(crate) async fn with_certificates(
    registry: &Arc<dyn ServerRegistry>,
    data_root: &Path,
    changed: Vec<(String, UnitStatus<ServerDetail>)>,
) -> Vec<ServerStatus> {
    let needs_a_cache = changed
        .iter()
        .any(|(_, unit_status)| ServerStatus::run_certificate(unit_status).is_none());
    let records = if needs_a_cache {
        let registry = Arc::clone(registry);
        match tokio::task::spawn_blocking(move || registry.read_all()).await {
            Ok(Ok(records)) => records,
            Ok(Err(error)) => {
                log::error!("[servers] reading the servers for their certificates failed: {error}");
                Vec::new()
            }
            Err(error) => {
                log::error!("[servers] reading the servers for their certificates failed: {error}");
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    join_all(changed.into_iter().map(|(domain, unit_status)| {
        let record = records.iter().find(|record| record.domain() == domain);
        async move {
            let certificate = match (ServerStatus::run_certificate(&unit_status), record) {
                (Some(certificate), _) => certificate.clone(),
                (None, Some(record)) => certificate_state(data_root, record, &unit_status).await,
                (None, None) => {
                    log::warn!(
                        "[servers] the status of {domain} wasn't emitted: its certificate cache couldn't be found"
                    );
                    return None;
                }
            };
            Some(ServerStatus {
                domain,
                unit_status,
                certificate,
            })
        }
    }))
    .await
    .into_iter()
    .flatten()
    .collect()
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
