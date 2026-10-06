//! [`Reconciler`]: starts and stops servers to match their run policies.
//!
//! It runs when the host has set up, after each of the base's commands, and
//! whenever whatever watches the policies' conditions (the clock, the app
//! being in use) says they may have changed. Each pass reads the registry,
//! takes [`servers_rust::servers_to_run`] at the current time, stops every
//! server it started that is no longer among them, and starts every one among
//! them it hasn't started.
//!
//! A server it started stays started until it leaves that set, even if its
//! run has since stopped on its own or failed: a failed server isn't retried
//! on every pass, only once its policy is set again or the app restarts.

use std::collections::BTreeSet;
use std::sync::Arc;

use chrono::Utc;
use servers_rust::{RegistryError, ServerRecord, ServerRegistry};
use shared_structures_rust::server_run_state::ServerRunState;
use tauri_plugin_log::log;
use tokio::sync::Mutex;

use crate::{ServerService, ServerStatuses};

/// What a [`Reconciler`] pass with nothing to run tells the service, when no
/// server's policy is active.
const NO_ACTIVE_POLICY: &str = "no server's run policy is active";

/// Starts and stops servers to match their run policies. One pass runs at a
/// time.
#[derive(Default)]
pub(crate) struct Reconciler {
    /// The domains of the servers this reconciler has started and not stopped.
    started_domains: Mutex<BTreeSet<String>>,
}

impl Reconciler {
    /// Start and stop servers so the ones running are those whose policy is
    /// active now. A registry that can't be read stops nothing: its error is
    /// logged, and with nothing started the service is told it, so a run the
    /// platform starts on its own ends with it.
    pub(crate) async fn reconcile(
        &self,
        registry: &Arc<dyn ServerRegistry>,
        service: &dyn ServerService,
        statuses: &ServerStatuses,
    ) {
        let mut started_domains = self.started_domains.lock().await;
        let servers = match read_servers(registry).await {
            Ok(servers) => servers,
            Err(error) => {
                log::error!("[servers] the registered servers can't be read: {error}");
                if started_domains.is_empty() {
                    service.publish_no_server(format!(
                        "the registered servers can't be read: {error}"
                    ));
                }
                return;
            }
        };
        let servers_to_run = servers_rust::servers_to_run(servers, Utc::now());
        let domains_to_run: BTreeSet<String> =
            servers_to_run.iter().map(ServerRecord::domain).collect();

        for domain in started_domains.clone() {
            if domains_to_run.contains(&domain) {
                continue;
            }
            log::info!("[servers] stopping {domain}: its run policy isn't active");
            match service.stop(&domain).await {
                Ok(()) => {
                    started_domains.remove(&domain);
                }
                Err(error) => log::error!("[servers] stopping {domain} failed: {error}"),
            }
        }
        for server in &servers_to_run {
            let domain = server.domain();
            if started_domains.contains(&domain) {
                continue;
            }
            log::info!("[servers] starting {domain}: its run policy is active");
            if let Err(error) = service.start(server).await {
                log::error!("[servers] starting {domain} failed: {error}");
                statuses.report_run_state(
                    &domain,
                    ServerRunState::Stopped { error: Some(error) },
                    Utc::now(),
                );
            }
            started_domains.insert(domain);
        }
        if started_domains.is_empty() {
            service.publish_no_server(NO_ACTIVE_POLICY.to_owned());
        }
    }

    /// Stop the server with `domain` and, with it stopped, run `remove`; no
    /// pass starts it again in between.
    ///
    /// # Errors
    ///
    /// Why the server couldn't be stopped, with `remove` never run, or what
    /// `remove` failed with.
    pub(crate) async fn stop_and_remove<E>(
        &self,
        domain: &str,
        service: &dyn ServerService,
        stop_failed: impl FnOnce(String) -> E,
        remove: impl AsyncFnOnce() -> Result<(), E>,
    ) -> Result<(), E> {
        let mut started_domains = self.started_domains.lock().await;
        service.stop(domain).await.map_err(stop_failed)?;
        started_domains.remove(domain);
        remove().await
    }
}

/// Every registered server, read off the async runtime.
async fn read_servers(
    registry: &Arc<dyn ServerRegistry>,
) -> Result<Vec<ServerRecord>, RegistryError> {
    let registry = Arc::clone(registry);
    tokio::task::spawn_blocking(move || registry.read_all())
        .await
        .map_err(|error| RegistryError::storage("reading the registered servers", error))?
}
