//! [`ServerUnits`]: the one place a server's record becomes a unit on the
//! unit runner, the way the servers commands change and read the servers'
//! units, and how a launch's in-app browser view counts toward their
//! `WhileOpen` run policy.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tokio::sync::mpsc;
use wildflowerhealthio_servers::{ServerDetail, ServerRecord, ServerUnit};
use wildflowerhealthio_shared_structures::request_caller::ForwardedRequest;
use wildflowerhealthio_tauri_unit_runner::{RunPolicy, TauriUnitRunner, UnitId, UnitStatuses};
use wildflowerhealthio_wildflower_server::WildflowerServerConfig;

/// Builds the config a server's run reads from its record: what the host
/// derives at build time, from its platform paths and from the record. Called
/// at the start of every run of the server, so a failure is a failed run.
pub type ServerConfigBuilder =
    Arc<dyn Fn(&ServerRecord) -> anyhow::Result<WildflowerServerConfig> + Send + Sync>;

/// Pushes the install's servers to `TauriUnitRunner`, each as a unit whose id
/// is the server's domain, and reads their statuses back.
///
/// The forwarded-request channel is the host's, shared by every run of every
/// server.
#[derive(Clone)]
pub struct ServerUnits {
    runner: TauriUnitRunner<ServerDetail>,
    server_config: ServerConfigBuilder,
    forwarded_request_tx: mpsc::Sender<ForwardedRequest>,
    /// The launch views opened and not yet reported closed.
    open_launch_views: Arc<Mutex<BTreeSet<String>>>,
}

impl ServerUnits {
    /// Server units on `runner`, whose runs read the config `server_config`
    /// builds and report each request their tunnels relay on
    /// `forwarded_request_tx`.
    #[must_use]
    pub fn new(
        runner: TauriUnitRunner<ServerDetail>,
        server_config: ServerConfigBuilder,
        forwarded_request_tx: mpsc::Sender<ForwardedRequest>,
    ) -> Self {
        Self {
            runner,
            server_config,
            forwarded_request_tx,
            open_launch_views: Arc::default(),
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
        let forwarded_request_tx = self.forwarded_request_tx.clone();
        self.runner.set_unit(unit_id, run_policy, move || {
            Ok(ServerUnit::new(
                server_config(&record)?,
                forwarded_request_tx.clone(),
            ))
        });
    }

    /// Give the server `domain` the run policy `run_policy` on
    /// `TauriUnitRunner`, keeping the record it was last pushed with. Even
    /// with the policy it already has, a pending restart is cancelled and the
    /// server starts at once if it should run.
    ///
    /// Call it after every registry write that changes only the server's run
    /// policy, when the server is set (see [`Self::holds`]); push a server that
    /// isn't.
    pub fn set_run_policy(&self, domain: &str, run_policy: RunPolicy) {
        self.runner
            .set_unit_policy(&UnitId::new(domain), run_policy);
    }

    /// Whether the server `domain` is set on `TauriUnitRunner`. It isn't when
    /// `servers.json` was unreadable at launch, or a failed removal couldn't
    /// read it to put the server back.
    #[must_use]
    pub fn holds(&self, domain: &str) -> bool {
        self.runner.statuses().contains_key(&UnitId::new(domain))
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

    /// A launch opened in the in-app browser view `view`. While it is open, it
    /// keeps the app present for the servers' `WhileOpen` run policy where the
    /// view moves the app to the background.
    pub fn launch_view_opened(&self, view: &str) {
        self.lock_open_launch_views().insert(view.to_owned());
        self.runner.browser_view_opened(view);
    }

    /// The browser of the in-app browser view `view`, a launch's, keeps the app
    /// alive under it, so the servers need no background session for it.
    pub fn launch_view_kept_alive(&self, view: &str) {
        self.runner.browser_view_kept_alive(view);
    }

    /// The in-app browser view `view`, a launch's, closed.
    pub fn launch_view_closed(&self, view: &str) {
        self.lock_open_launch_views().remove(view);
        self.runner.browser_view_closed(view);
    }

    /// Whether a launch's in-app browser view is open: opened and not yet
    /// reported closed. A desktop's views, default-browser tabs, are never
    /// reported closed.
    #[must_use]
    pub fn shows_a_launch_view(&self) -> bool {
        !self.lock_open_launch_views().is_empty()
    }

    /// The open launch views, locked. Each holder only inserts, removes or
    /// reads, so a holder that panicked left the set whole.
    fn lock_open_launch_views(&self) -> MutexGuard<'_, BTreeSet<String>> {
        self.open_launch_views
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}
