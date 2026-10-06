//! Tauri host glue for the servers slice: the base's commands over its
//! servers, the reconciler that starts and stops servers to match their run
//! policies, and each server's status, emitted as the `server-status` event.
//! Every decision about a server's record lives in [`servers_rust`], which
//! needs no webview to be tested.
//!
//! - [`servers_list`], invoked as `invoke('servers_list')`, answers with every
//!   registered server and its current status, or the registry's error when
//!   `servers.json` can't be read.
//! - [`server_add`], invoked as
//!   `invoke('server_add', { relay, tunnelName, token })`, enrols a tunnel at
//!   a relay and registers the server (see [`servers_rust::add_server`]),
//!   answering with the server's domain.
//! - [`server_set_credentials`], invoked as
//!   `invoke('server_set_credentials', { domain, token })`, replaces a
//!   registered server's token, checked with its relay the same way, or
//!   replaced at once for a rathole relay (see
//!   [`servers_rust::set_server_credentials`]).
//! - [`server_set_run_policy`], invoked as
//!   `invoke('server_set_run_policy', { domain, policy })`, sets a server's
//!   run policy from a [`RunPolicyChoice`](servers_rust::RunPolicyChoice),
//!   setting every other server `Off` unless the choice is `Off` (see
//!   [`servers_rust::set_run_policy`]), and answers with the policy stored.
//! - [`server_update`], invoked as
//!   `invoke('server_update', { domain, launcherUrl, stagingCertificates })`,
//!   sets a server's launcher and certificate source.
//! - [`server_remove`], invoked as `invoke('server_remove', { domain })`,
//!   stops a server and deletes it, folder and all.
//!
//! Parameters are top-level and camelCase in the invoke payload, which Tauri
//! maps onto the commands' snake_case parameters; answers are camelCase. A
//! failure the command reaches is its error serialised as `{"kind",
//! "message"}`; a payload Tauri can't decode into the parameters is rejected
//! by Tauri before the command runs, with a plain string naming the
//! parameter.
//!
//! **The reconciler.** After every command, and once when the host calls
//! [`reconcile_servers`] at setup, the servers whose policy is active are
//! started and the rest stopped, through the [`ServerService`] port the app
//! implements. At most [`servers_rust::MAX_RUNNING_SERVERS`] run. A server
//! that fails to start has its status `Stopped` with the error, and is tried
//! again once `server_set_run_policy` sets its policy again.
//!
//! **Statuses.** Each server's [`ServerStatus`] (its run state, its tunnel's
//! liveness, and when the current run began) is emitted on
//! [`SERVER_STATUS_EVENT`] whenever it changes, and `servers_list` answers
//! with the current one. The service reports run states and tunnel liveness
//! to the [`ServerStatuses`] it is built with.
//!
//! The tunnel's token goes in and never comes back: no command answers with
//! it or logs it, and `servers_list` writes the redaction marker in its place.
//!
//! The app registers the commands in its `invoke_handler` and grants them to
//! the `main` webview only, through its app-defined `allow-server-enrolment`
//! and `allow-server-management` permissions. [`manage_servers`] puts the
//! [`ServersState`] they read in the app's managed state.

mod commands;
#[cfg(test)]
mod fake_service;
mod reconciler;
mod server_service;
mod server_status;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use servers_rust::{JsonServerRegistry, ServerRegistry};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_log::log;

pub use commands::{
    server_add, server_remove, server_set_credentials, server_set_run_policy, server_update,
    servers_list, ListedServer,
};
pub use server_service::ServerService;
pub use server_status::{ServerStatus, ServerStatuses, SERVER_STATUS_EVENT};

use reconciler::Reconciler;

/// What the servers commands work through: the install's registry, the data
/// root its servers' folders are in, the service that runs them, their
/// statuses, and the reconciler.
pub struct ServersState {
    pub(crate) registry: Arc<dyn ServerRegistry>,
    pub(crate) data_root: PathBuf,
    pub(crate) service: Arc<dyn ServerService>,
    pub(crate) statuses: ServerStatuses,
    pub(crate) reconciler: Reconciler,
}

impl ServersState {
    /// `service` reports to `statuses`.
    #[must_use]
    pub fn new(
        registry: Arc<dyn ServerRegistry>,
        data_root: &Path,
        service: Arc<dyn ServerService>,
        statuses: ServerStatuses,
    ) -> Self {
        Self {
            registry,
            data_root: data_root.to_owned(),
            service,
            statuses,
            reconciler: Reconciler::default(),
        }
    }

    /// Start and stop servers to match their run policies now.
    pub async fn reconcile(&self) {
        self.reconciler
            .reconcile(&self.registry, self.service.as_ref(), &self.statuses)
            .await;
    }
}

/// Manage the [`ServersState`] over `<data_root>/servers.json`, whose servers
/// the service `service` builds runs, reporting to the statuses it is given.
/// Each status change is emitted to the app's webviews on
/// [`SERVER_STATUS_EVENT`]. `data_root` is the directory the host already
/// resolved and created in `setup()`. Call once per app lifecycle.
pub fn manage_servers<R: Runtime>(
    app: &AppHandle<R>,
    data_root: &Path,
    service: impl FnOnce(ServerStatuses) -> Arc<dyn ServerService>,
) {
    let emitting_app = app.clone();
    let statuses = ServerStatuses::new(move |status| {
        if let Err(error) = emitting_app.emit(SERVER_STATUS_EVENT, status) {
            log::error!(
                "[servers] failed to emit the status of {}: {error}",
                status.domain
            );
        }
    });
    app.manage(ServersState::new(
        Arc::new(JsonServerRegistry::in_data_root(data_root)),
        data_root,
        service(statuses.clone()),
        statuses,
    ));
}

/// Start the servers whose policy is active: the reconciler's first pass,
/// which the host runs once it has set up. The base's commands run it after
/// each change.
pub async fn reconcile_servers<R: Runtime>(app: &AppHandle<R>) {
    app.state::<ServersState>().reconcile().await;
}
