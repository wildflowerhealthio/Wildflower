//! [`ServerUnits`]: the one place a server's record becomes a unit on the
//! unit runner, and the way the servers commands change and read the
//! servers' units.

use std::sync::Arc;

use servers_rust::{ServerDetail, ServerRecord, ServerUnit};
use shared_structures_rust::request_caller::ForwardedRequest;
use tauri_unit_runner::{RunPolicy, TauriUnitRunner, UnitId, UnitStatuses};
use tokio::sync::mpsc;
use wildflower_server_rust::{HostPorts, WildflowerServerConfig};

/// Builds the config a server's run reads from its record: what the host
/// derives at build time, from its platform paths and from the record. Called
/// at the start of every run of the server, so a failure is a failed run.
pub type ServerConfigBuilder =
    Arc<dyn Fn(&ServerRecord) -> anyhow::Result<WildflowerServerConfig> + Send + Sync>;

/// Pushes the install's servers to `TauriUnitRunner`, each as a unit whose id
/// is the server's domain, and reads their statuses back.
///
/// The host's ports and the forwarded-request channel are the host's, shared
/// by every run of every server.
#[derive(Clone)]
pub struct ServerUnits {
    runner: TauriUnitRunner<ServerDetail>,
    server_config: ServerConfigBuilder,
    host_ports: HostPorts,
    forwarded_request_sender: mpsc::Sender<ForwardedRequest>,
}

impl ServerUnits {
    /// Server units on `runner`, whose runs read the config `server_config`
    /// builds, use the host's `host_ports`, and report each request their
    /// tunnels relay on `forwarded_request_sender`.
    #[must_use]
    pub fn new(
        runner: TauriUnitRunner<ServerDetail>,
        server_config: ServerConfigBuilder,
        host_ports: HostPorts,
        forwarded_request_sender: mpsc::Sender<ForwardedRequest>,
    ) -> Self {
        Self {
            runner,
            server_config,
            host_ports,
            forwarded_request_sender,
        }
    }

    /// Set the server `record` describes on `TauriUnitRunner`, with its run
    /// policy and a factory that builds a fresh [`ServerUnit`] for each run
    /// from `record`. A server already set is replaced: a run of its old record
    /// stops, and it starts again from `record` if its policy wants it running.
    ///
    /// Call it after every registry write that changes `record`.
    pub fn push(&self, record: ServerRecord) {
        let unit_id = UnitId::new(record.domain());
        let run_policy = record.run_policy;
        let server_config = Arc::clone(&self.server_config);
        let host_ports = self.host_ports.clone();
        let forwarded_request_sender = self.forwarded_request_sender.clone();
        self.runner.set_unit(unit_id, run_policy, move || {
            Ok(ServerUnit::new(
                server_config(&record)?,
                host_ports.clone(),
                forwarded_request_sender.clone(),
            ))
        });
    }

    /// Give the server `domain` the run policy `run_policy` on
    /// `TauriUnitRunner`, keeping the record it was last pushed with. Even
    /// with the policy it already has, a pending restart is cancelled and the
    /// server starts at once if it should run.
    ///
    /// Call it after every registry write that changes only the server's run
    /// policy.
    pub fn set_run_policy(&self, domain: &str, run_policy: RunPolicy) {
        self.runner
            .set_unit_policy(&UnitId::new(domain), run_policy);
    }

    /// Stop the server `domain`, wait for its run to end, and take it off
    /// `TauriUnitRunner`, its status included.
    ///
    /// Call it before deleting the server's folder.
    pub async fn remove(&self, domain: &str) {
        self.runner.remove_unit(&UnitId::new(domain)).await;
    }

    /// Every server's status on `TauriUnitRunner`, keyed by domain.
    #[must_use]
    pub fn statuses(&self) -> UnitStatuses<ServerDetail> {
        self.runner.statuses()
    }
}
