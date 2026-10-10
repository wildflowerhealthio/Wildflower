//! Tauri host glue for the servers: the install's servers on the unit
//! runner, the notifications about them, the `server-status` and
//! `pending-consent` events, and the base's commands, launching a server's
//! launcher included. Every decision lives in [`servers_rust`], which needs no
//! webview to be tested; this crate is only the glue.
//!
//! [`host_servers`], called once from the app's `setup()`:
//!
//! - pushes every server in `servers.json` to the app's
//!   [`TauriUnitRunner`](tauri_unit_runner_rust::TauriUnitRunner) as a unit whose
//!   id is its domain, with its run policy and a factory that builds a fresh
//!   [`ServerUnit`](servers_rust::ServerUnit) for each run (see
//!   [`ServerUnits::push`]). An unreadable registry is logged, and no server
//!   runs;
//! - emits the [`SERVER_STATUS_EVENT`] to the base for each server whose
//!   status on `TauriUnitRunner` changed, with its certificate's state: its
//!   run's, or what its cache says; and the [`PENDING_CONSENT_EVENT`]
//!   for each server whose oldest waiting consent changed, bringing the
//!   desktop window forward when a server gets one;
//! - posts a stop notification for each new stop of a server's run, read from
//!   `TauriUnitRunner`'s statuses, and the per-caller notifications for the
//!   requests the servers' tunnels relay;
//! - puts the [`ServersState`] the commands read in the app's managed state.
//!
//! The commands write the registry, then push the server they changed. One
//! async mutex orders each command's registry write and its push, so
//! `TauriUnitRunner` always ends up with the record as last written.
//!
//! - [`servers_list`], invoked as `invoke('servers_list')`, answers with
//!   every registered server, its status on `TauriUnitRunner` and its
//!   certificate's state, as [`ListedServer`](servers_rust::ListedServer)s,
//!   or with the error `servers.json` couldn't be read with.
//! - [`server_add`], invoked as
//!   `invoke('server_add', { relay, tunnelName, token })`, enrols a tunnel at
//!   a relay and registers the server with the app's default launcher (see
//!   [`servers_rust::add_server`]), answering with the server's domain.
//! - [`server_set_credentials`], invoked as
//!   `invoke('server_set_credentials', { domain, token })`, replaces a
//!   registered server's token, checked with its relay the same way, or
//!   replaced at once for a rathole relay (see
//!   [`servers_rust::set_server_credentials`]).
//! - [`server_set_run_policy`], invoked as
//!   `invoke('server_set_run_policy', { domain, choice })`, stores the
//!   [`RunPolicyChoice`](servers_rust::RunPolicyChoice) as a run policy and
//!   gives `TauriUnitRunner` that policy, answering with it.
//! - [`server_update`], invoked as
//!   `invoke('server_update', { domain, launcherUrl, certificateAuthority })`,
//!   sets the launcher and the certificate authority, and pushes the server
//!   again only when a field its runs read changed.
//! - [`server_remove`], invoked as `invoke('server_remove', { domain })`,
//!   takes the server off `TauriUnitRunner`, waiting for its run to end, then
//!   deletes its folder and its record.
//! - [`pending_consents_list`], invoked as `invoke('pending_consents_list')`,
//!   answers with the oldest consent waiting on each running server.
//! - [`server_consent_get`], [`server_consent_approve`] and
//!   [`server_consent_deny`], invoked with the server's `domain` and a
//!   consent's key or approval, read a waiting consent and decide it as the
//!   host's Owner, through the running server's gatekeeper in-process (see
//!   [`servers_rust::ServerConsentDecider`]); a server that isn't running
//!   answers `serverNotRunning`.
//! - [`server_launch`], invoked as `invoke('server_launch', { domain })`,
//!   opens the server's launcher in a native web view of its own, at its
//!   launcher URL with `iss` and a `launch` its running gatekeeper minted for
//!   any client (see [`servers_rust::ServerLaunchMinter`]); a server that
//!   isn't running, reachable through its relay and holding a valid
//!   certificate answers why at once. It never changes the run policy.
//!
//! Parameters are top-level and camelCase in the invoke payload, which Tauri
//! maps onto the commands' snake_case parameters; answers are camelCase. The
//! enrolment commands trim the token's surrounding whitespace, as the relay
//! does, and refuse one left empty. Enrolment gets a
//! [`ReqwestRelayClient`](servers_rust::ReqwestRelayClient) for a relay's site,
//! built when it asks for one.
//!
//! The token goes in and never comes back: no command answers with it or
//! logs it. A failure the command reaches answers with its error serialised
//! as `{"kind", "message"}`; every value a user types is checked there. A
//! payload Tauri can't decode into the parameters is rejected by Tauri before
//! the command runs, with a plain string naming the parameter.
//!
//! The app registers every command in its `invoke_handler` and grants them
//! to the `main` webview only, through its app-defined
//! `allow-server-enrolment` (`server_add`, `server_set_credentials`),
//! `allow-server-consents` (the consent commands) and
//! `allow-server-management` (the rest, `server_launch` included)
//! permissions.

mod commands;
mod consent_commands;
mod launch_commands;
mod notifications;
mod pending_consents;
mod server_status;
mod server_units;
#[cfg(test)]
mod test_gatekeeper;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use servers_rust::{JsonServerRegistry, ServerDetail, ServerRecord, ServerRegistry};
use tauri::{AppHandle, Manager};
use tauri_plugin_log::log;
use tauri_unit_runner_rust::TauriUnitRunner;
use tokio::sync::{mpsc, Mutex};
use url::Url;
use wildflower_server_rust::{HostPorts, WildflowerServerConfig};

pub use commands::{
    server_add, server_remove, server_set_credentials, server_set_run_policy, server_update,
    servers_list,
};
pub use consent_commands::{
    pending_consents_list, server_consent_approve, server_consent_deny, server_consent_get,
};
pub use launch_commands::server_launch;
pub use pending_consents::PENDING_CONSENT_EVENT;
pub use server_status::SERVER_STATUS_EVENT;
pub use server_units::{ServerConfigBuilder, ServerUnits};

/// The webview the servers' events go to and the window brought forward for a
/// consent: the base's.
pub(crate) const BASE_WEBVIEW_LABEL: &str = "main";

/// How many forwarded-request reports may wait for the request notifications
/// before the servers start dropping them (see
/// `wildflower_server_rust::ServerObservers`).
pub const FORWARDED_REQUEST_CAPACITY: usize = 256;

/// What the servers commands work through: the install's registry and the
/// data root its servers' folders are in, the launcher a new server gets,
/// `TauriUnitRunner`'s server units, and the lock that orders each registry
/// write with its push.
pub struct ServersState {
    pub(crate) registry: Arc<dyn ServerRegistry>,
    /// The directory holding `servers.json` and each server's folder.
    pub(crate) data_root: PathBuf,
    /// The launcher [`server_add`] gives a new server.
    pub(crate) default_launcher_url: Url,
    pub(crate) server_units: ServerUnits,
    /// Held by a command from before its registry write until after it has
    /// pushed the result, so pushes reach `TauriUnitRunner` in the order the
    /// writes were made.
    pub(crate) registry_writes: Mutex<()>,
}

impl ServersState {
    /// The commands' state over `registry`, whose servers' folders are in
    /// `data_root`, giving a new server `default_launcher_url` and pushing to
    /// `server_units`.
    #[must_use]
    pub fn new(
        registry: Arc<dyn ServerRegistry>,
        data_root: PathBuf,
        default_launcher_url: Url,
        server_units: ServerUnits,
    ) -> Self {
        Self {
            registry,
            data_root,
            default_launcher_url,
            server_units,
            registry_writes: Mutex::new(()),
        }
    }
}

/// Run the install's servers on `runner` and post the notifications about
/// them, then manage the [`ServersState`] the commands read: see the
/// [crate docs](crate).
///
/// `data_root` is the directory the host already resolved and created in
/// `setup()`, holding `servers.json`. `default_launcher_url` is the launcher
/// [`server_add`] gives a new server. Each run of a server reads the config
/// `server_config` builds from its record, and uses the host's `host_ports`,
/// which every run of every server shares. Call once per app lifecycle, from
/// `setup()`.
pub fn host_servers(
    app: &AppHandle,
    data_root: &Path,
    default_launcher_url: Url,
    runner: &TauriUnitRunner<ServerDetail>,
    host_ports: HostPorts,
    server_config: impl Fn(&ServerRecord) -> anyhow::Result<WildflowerServerConfig>
        + Send
        + Sync
        + 'static,
) {
    let registry = Arc::new(JsonServerRegistry::in_data_root(data_root));
    let (forwarded_request_tx, forwarded_request_rx) = mpsc::channel(FORWARDED_REQUEST_CAPACITY);
    let server_units = ServerUnits::new(
        runner.clone(),
        Arc::new(server_config),
        host_ports,
        forwarded_request_tx,
    );
    match registry.read_all() {
        Ok(records) => {
            for record in records {
                log::info!(
                    "[servers] setting {} on the unit runner, run policy {:?}",
                    record.domain(),
                    record.run_policy
                );
                server_units.push(record);
            }
        }
        Err(error) => {
            log::error!("[servers] the registered servers are unreadable, so none runs: {error}");
        }
    }
    tauri::async_runtime::spawn(server_status::emit_server_statuses(
        app.clone(),
        runner.subscribe(),
        Arc::clone(&registry) as Arc<dyn ServerRegistry>,
        data_root.to_path_buf(),
    ));
    tauri::async_runtime::spawn(pending_consents::emit_pending_consents(
        app.clone(),
        runner.subscribe(),
    ));
    tauri::async_runtime::spawn(notifications::post_stop_notifications(
        app.clone(),
        runner.subscribe_stops(),
    ));
    tauri::async_runtime::spawn(notifications::post_request_notifications(
        app.clone(),
        forwarded_request_rx,
    ));
    app.manage(ServersState::new(
        registry,
        data_root.to_path_buf(),
        default_launcher_url,
        server_units,
    ));
}
