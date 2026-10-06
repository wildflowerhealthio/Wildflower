//! [`HostServerService`]: the [`ServerService`] the servers slice's reconciler
//! starts and stops servers through, over the background server service.
//!
//! One server runs at a time (`servers_rust::MAX_RUNNING_SERVERS`). Starting
//! one builds its config and context, publishes it as the [`ServerToRun`] the
//! service's runs wait for, and starts the service; stopping it publishes
//! [`ServerToRun::NoServer`], stops the service, and waits at the run gate for
//! the run to end. While a server runs, a reporter task copies its run state
//! and tunnel liveness into its status.

use std::path::{Path, PathBuf};

use background_server_service_rust::{ServerHost, ServerToRun};
use background_server_service_tauri_rust::{report_server_failure, ServerServiceHandle};
use chrono::Utc;
use servers_rust::ServerRecord;
use servers_tauri_rust::{ServerService, ServerStatuses};
use shared_structures_rust::server_run_state::ServerRunState;
use shared_structures_rust::tunnel_service::TunnelLiveness;
use shared_structures_rust::ServerRuntimeConfig;
use tauri::async_runtime::JoinHandle;
use tauri::AppHandle;
use tauri_plugin_log::log;
use tokio::sync::{watch, Mutex};
use url::Url;

use crate::{server_config, LOOPBACK_HOSTNAME, LOOPBACK_PORT};

/// The server the host is running, and the task reporting its status.
struct RunningServer {
    domain: String,
    status_reporter: JoinHandle<()>,
}

/// Runs the host's servers through the background server service.
pub(crate) struct HostServerService {
    app_handle: AppHandle,
    data_root: PathBuf,
    server_host: ServerHost,
    run_state: watch::Receiver<ServerRunState>,
    tunnel_liveness: watch::Receiver<Option<TunnelLiveness>>,
    server_to_run_sender: watch::Sender<ServerToRun>,
    background_service: ServerServiceHandle<tauri::Wry>,
    statuses: ServerStatuses,
    running_server: Mutex<Option<RunningServer>>,
}

impl HostServerService {
    /// The service over `server_host`, publishing what to run on
    /// `server_to_run_sender` and starting the service through
    /// `background_service`. Reports to `statuses`.
    pub(crate) fn new(
        app_handle: &AppHandle,
        data_root: &Path,
        server_host: ServerHost,
        server_to_run_sender: watch::Sender<ServerToRun>,
        background_service: ServerServiceHandle<tauri::Wry>,
        statuses: ServerStatuses,
    ) -> Self {
        Self {
            app_handle: app_handle.clone(),
            data_root: data_root.to_owned(),
            run_state: server_host.subscribe_run_state(),
            tunnel_liveness: server_host.subscribe_tunnel_liveness(),
            server_host,
            server_to_run_sender,
            background_service,
            statuses,
            running_server: Mutex::new(None),
        }
    }

    /// The config `server` runs with, from its folder under the data root.
    fn server_config(
        &self,
        server: &ServerRecord,
    ) -> anyhow::Result<wildflower_server_rust::WildflowerServerConfig> {
        // Hostname/port come from the shared `tauri-shared-config.json` (see
        // `LOOPBACK_HOSTNAME`/`LOOPBACK_PORT`).
        let loopback_base_url = Url::parse(&format!("http://{LOOPBACK_HOSTNAME}:{LOOPBACK_PORT}"))?;
        let runtime = ServerRuntimeConfig {
            // Loopback-only: the OS rejects non-local peers at the socket, so
            // the bearer secret is never the only thing between LAN peers and
            // FHIR health data.
            loopback_base_url,
            server_dir: server.server_dir(&self.data_root),
        };
        server_config(runtime, &self.data_root, &self.app_handle)
    }

    /// Copy every later change of the shared run state and tunnel liveness
    /// into `domain`'s status, until aborted when the server is stopped. The
    /// values as they stand now belong to the previous run, so only changes
    /// are copied.
    fn report_status_of(&self, domain: &str) -> JoinHandle<()> {
        let domain = domain.to_owned();
        let statuses = self.statuses.clone();
        let mut run_state = self.run_state.clone();
        let mut tunnel_liveness = self.tunnel_liveness.clone();
        run_state.mark_unchanged();
        tunnel_liveness.mark_unchanged();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::select! {
                    changed = run_state.changed() => {
                        if changed.is_err() {
                            return;
                        }
                        let current = run_state.borrow_and_update().clone();
                        statuses.report_run_state(&domain, current, Utc::now());
                    }
                    changed = tunnel_liveness.changed() => {
                        if changed.is_err() {
                            return;
                        }
                        let current = tunnel_liveness.borrow_and_update().clone();
                        statuses.report_tunnel_liveness(&domain, current);
                    }
                }
            }
        })
    }
}

#[async_trait::async_trait]
impl ServerService for HostServerService {
    async fn start(&self, server: &ServerRecord) -> Result<(), String> {
        let domain = server.domain();
        let mut running_server = self.running_server.lock().await;
        if let Some(running) = running_server.as_ref() {
            return Err(format!(
                "{} is running, and one server runs at a time",
                running.domain
            ));
        }
        log::info!(
            "[servers] starting {domain} from {}",
            server.server_dir(&self.data_root).display()
        );
        let config = match self.server_config(server) {
            Ok(config) => config,
            Err(error) => {
                let error = format!("the server's config couldn't be built: {error:#}");
                // Said the way a failed run is, so it shows even before the
                // base has loaded.
                report_server_failure(&self.app_handle, &error);
                self.publish_no_server(format!("{domain} can't run: {error}"));
                return Err(error);
            }
        };
        // Reported from before the start, so no state of this run is missed.
        let status_reporter = self.report_status_of(&domain);
        self.server_to_run_sender
            .send_replace(ServerToRun::Server(Box::new(
                self.server_host.context(config),
            )));
        if let Err(error) = self.background_service.start().await {
            status_reporter.abort();
            self.publish_no_server(format!("{domain} didn't start: {error}"));
            return Err(error);
        }
        *running_server = Some(RunningServer {
            domain,
            status_reporter,
        });
        Ok(())
    }

    async fn stop(&self, domain: &str) -> Result<(), String> {
        let mut running_server = self.running_server.lock().await;
        let Some(running) = running_server.take_if(|running| running.domain == domain) else {
            return Ok(());
        };
        log::info!("[servers] stopping {domain}");
        self.server_to_run_sender
            .send_replace(ServerToRun::NoServer {
                reason: format!("{domain} was stopped"),
            });
        if let Err(error) = self.background_service.stop().await {
            *running_server = Some(running);
            return Err(error);
        }
        self.server_host.wait_for_runs_to_end().await;
        running.status_reporter.abort();
        // The reporter may not have seen the run's last state yet.
        let last_run_state = self.run_state.borrow().clone();
        self.statuses
            .report_run_state(domain, last_run_state, Utc::now());
        self.statuses.report_tunnel_liveness(domain, None);
        Ok(())
    }

    fn publish_no_server(&self, reason: String) {
        self.server_to_run_sender
            .send_replace(ServerToRun::NoServer { reason });
    }
}
